import { getEndpoint } from "./GetEndpoint";
import { updateMeta } from "./MessageHandler";
import { distribute } from "./MessageHandler";
import { Endpoint } from "./types/Endpoint";
import log from "./utils/logger";
import { getDb } from "./utils/pgsql";
import { Worker, isMainThread} from "worker_threads";
import { health } from "./utils/health";

function isMessageEmpty(msg: any): boolean {
	if (!msg) return true;
	if (Array.isArray(msg.attachments) && msg.attachments.length > 0)
		return false;
	if (msg.author && (msg.author.avatar || msg.author.id || msg.author.name))
		return false;
	if (
		msg.content !== null &&
		msg.content !== undefined &&
		msg.content !== "" &&
		msg.content !== "None"
	)
		return false;
	if (
		msg.embed &&
		((msg.embed.description && msg.embed.description !== "None") ||
			(msg.embed.title && msg.embed.title !== "None") ||
			(Array.isArray(msg.embed.fields) && msg.embed.fields.length > 0))
	)
		return false;
	if (msg.isReply === true) return false;
	if (msg.reply && (msg.reply.author || msg.reply.message)) return false;
	if (msg.sender !== null && msg.sender !== undefined) return false;
	if (msg["sender-channel"] !== null && msg["sender-channel"] !== undefined)
		return false;
	return true;
}

export async function processMessageQueue(endpointId: bigint) {
	const initialEndpoint: Endpoint | undefined = await getEndpoint(endpointId);
	if (!initialEndpoint) return;

	if (!isMessageEmpty(initialEndpoint.meta.message)) {
		const sent = await distribute(endpointId, initialEndpoint);
		if (!sent) {
			log("ERROR", `Failed to send in-flight message for ${endpointId.toString()}`);
			return;
		}
	}

	let safetyCounter = 0;
	while (safetyCounter < 200) {
		const endpoint = await getEndpoint(endpointId);
		if (!endpoint) return;

		const cache = endpoint.meta._message_cache;
		if (!Array.isArray(cache) || cache.length === 0) {
			return;
		}

		if (!isMessageEmpty(endpoint.meta.message)) {
			const sent = await distribute(endpointId, endpoint);
			if (!sent) {
				log("ERROR", `Failed to flush occupied meta.message for ${endpointId.toString()}`);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			safetyCounter++;
			continue;
		}

		const nextMessage = cache[0];
		const newCache = cache.slice(1);

		await updateMeta(endpointId, {
			message: nextMessage,
			_message_cache: newCache,
		});
		health.record("queue:dequeue", `Dequeue message for ${endpointId.toString()}`);
		health.setCounter("messages_in_queue", newCache.length);

		const updated = await getEndpoint(endpointId);
		if (!updated) return;

		const sent = await distribute(endpointId, updated);
		if (!sent) {
			log("ERROR", `Failed to distribute dequeued message for ${endpointId.toString()}`);
			return;
		}

		health.increment("messages_processed");
		safetyCounter++;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	log("WARN", `Stopped queue processing for ${endpointId.toString()} due to safety limit`);
}

if (isMainThread) {
	new Worker(__filename);
} else {
	log("INFO", "QueueProcessor started");
	health.record("worker", "Queue processor worker running");
	let skippedEndpoints: { [key: string]: number } = {};
	let endpoints: string[] = [];
	let isProcessingQueue = false;
	async function processQueue() {
		if (isProcessingQueue) {
			return;
		}
		isProcessingQueue = true;
		const db = await getDb();
		if (!db) {
			isProcessingQueue = false;
			return;
		}
		try {
			const { rows } = await db.query(
				`SELECT
					id,
					COALESCE(jsonb_array_length(data->'meta'->'_message_cache'), 0) AS queue_len
				 FROM endpoints
				WHERE
					(
						data->'meta'->'_message_cache' IS NOT NULL
						AND jsonb_array_length(data->'meta'->'_message_cache') > 0
					)
					OR (
						data->'meta'->'message' IS NOT NULL
						AND data->'meta'->'message' <> '{"attachments": [], "author": {"avatar": null, "id": null, "name": null}, "content": null, "embed": {"description": "None", "fields": [], "footer": "None", "image": "None", "thumbnail": "None", "title": "None"}, "isReply": false, "reply": {"author": null, "message": null}, "sender": null, "sender-channel": null}'
					)`
			); 
			endpoints = rows.map((row) => row.id);
			health.setCounter("active_endpoints_with_work", endpoints.length);
			const totalQueued = rows.reduce(
				(sum, row) => sum + Number(row.queue_len || 0),
				0
			);
			health.setCounter("messages_in_queue", totalQueued);
			if (endpoints.length === 0) {
				log("INFO", "No endpoints with message cache found");
				health.record("queue:idle", "No endpoints with queued messages");
				return;
			}
			for (const endpointId of endpoints) {
				if (skippedEndpoints[endpointId]) {
					skippedEndpoints[endpointId]++;
					if (skippedEndpoints[endpointId] > 3) {
						log("INFO", `Skipping ${endpointId} as it has been skipped too many times`);
						health.record("queue:skip", `Skipping ${endpointId} after retries`);
						delete skippedEndpoints[endpointId];
						const clearedmessage = {
							attachments: [],
							author: {
								avatar: null,
								id: null,
								name: null,
							},
							content: null,
							embed: {
								description: "None",
								fields: [],
								footer: "None",
								image: "None",
								thumbnail: "None",
								title: "None",
							},
							isReply: false,
							reply: {
								author: null,
								message: null,
							},
							sender: null,
							"sender-channel": null,
						};

						await db.query(
							"UPDATE endpoints SET data = jsonb_set(data, '{meta,message}', $2::jsonb) WHERE id = $1",
							[endpointId, JSON.stringify(clearedmessage)]
						);
					}
				} else {
					skippedEndpoints[endpointId] = 1;
				}
				try {
					health.record("queue:process", `Process endpoint ${endpointId}`);
					await processMessageQueue(BigInt(endpointId));
				} catch (error) {
					log("ERROR", `Error processing queue for ${endpointId}:`, error);
					health.record("queue:error", `Error processing ${endpointId}`, { error: String(error) });
				}
			}
		} finally {
			db.release();
			health.setCounter("active_endpoints_with_work", 0);
			isProcessingQueue = false;
		}
	}
	setInterval(async () => {
		try {
			await processQueue();
		} catch (error) {
			log("ERROR", "Error processing queue:", error);
		}
	}, 5000);
}
