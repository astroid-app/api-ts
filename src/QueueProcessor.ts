import { getEndpoint } from "./GetEndpoint";
import { distribute } from "./MessageHandler";
import { Endpoint } from "./types/Endpoint";
import log from "./utils/logger";
import { getDb } from "./utils/pgsql";
import { Worker, isMainThread} from "worker_threads";
import { health } from "./utils/health";
import { installRequestLogger } from "./utils/requestLogger";

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

/**
 * Atomically moves the first queued message into meta.message and removes it
 * from the queue. Both jsonb_set calls read the same pre-update row, so a
 * concurrent enqueue can neither be lost nor resurrect an already-sent message.
 */
async function dequeue(endpointId: bigint): Promise<Endpoint | undefined> {
	const db = await getDb();
	if (!db) return undefined;
	try {
		const { rows } = await db.query(
			`UPDATE endpoints
			    SET data = jsonb_set(
			        jsonb_set(
			            jsonb_set(data, '{meta,message}', data->'meta'->'_message_cache'->0),
			            '{meta,_message_cache}',
			            (data->'meta'->'_message_cache') - 0),
			        '{meta,read}',
			        '{"discord": false, "guilded": false, "nerimity": false, "revolt": false}'::jsonb,
			        true)
			  WHERE id = $1
			    AND jsonb_typeof(data->'meta'->'_message_cache') = 'array'
			    AND jsonb_array_length(data->'meta'->'_message_cache') > 0
			RETURNING data`,
			[endpointId.toString()]
		);
		return rows.length > 0 ? (rows[0].data as Endpoint) : undefined;
	} finally {
		db.release();
	}
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

		const updated = await dequeue(endpointId);
		if (!updated) return;
		health.record("queue:dequeue", `Dequeue message for ${endpointId.toString()}`);
		health.decrement("messages_in_queue");

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
	const worker = new Worker(__filename);
	worker.on("message", (msg) => health.applyWorkerMessage(msg));
	worker.on("error", (err) => {
		log("ERROR", "QueueProcessor worker crashed:", err);
		health.record("queue:error", "Queue worker crashed", { error: String(err) });
	});
} else {
	installRequestLogger();
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
				// Cross-process lock: if another API instance shares this database,
				// only one of them may process a given endpoint at a time. Without
				// this, a second instance sees the in-flight meta.message and sends
				// it again (duplicate messages, one log line per instance).
				const { rows: lockRows } = await db.query(
					"SELECT pg_try_advisory_lock($1::bigint) AS locked",
					[endpointId]
				);
				if (!lockRows[0]?.locked) {
					log("DEBUG", `Endpoint ${endpointId} is being processed by another instance, skipping`);
					continue;
				}
				try {
					health.record("queue:process", `Process endpoint ${endpointId}`);
					await processMessageQueue(BigInt(endpointId));
					health.decrement("active_endpoints_with_work");
				} catch (error) {
					log("ERROR", `Error processing queue for ${endpointId}:`, error);
					health.record("queue:error", `Error processing ${endpointId}`, { error: String(error) });
				} finally {
					await db.query("SELECT pg_advisory_unlock($1::bigint)", [endpointId]);
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
