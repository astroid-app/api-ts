import log from "./utils/logger";
import { getDb } from "./utils/pgsql";
import { Endpoint } from "./types/Endpoint";
import { getAllEndpoints, getEndpoint } from "./GetEndpoint";
import { updateMeta } from "./MessageHandler";
import { updateEndpointConfig } from "./UpdateEndpointConfig";

export const writes = {
	config: {
		"self-user": "config.`self-user`",
		type_webhooks: "config.webhooks",
		webhooks: {
			discord: "config.webhooks.discord",
			guilded: "config.webhooks.guilded",
			revolt: "config.webhooks.revolt",
			nerimity: "config.webhooks.nerimity",
		},
		type_channels: "config.channels",
		channels: {
			discord: "config.channels.discord",
			guilded: "config.channels.guilded",
			revolt: "config.channels.revolt",
			nerimity: "config.channels.nerimity",
		},
		type_logs: "config.logs",
		logs: {
			discord: "config.logs.discord",
			guilded: "config.logs.guilded",
			revolt: "config.logs.revolt",
			nerimity: "config.logs.nerimity",
		},
		blacklist: "config.blacklist",
		"allowed-ids": "config.`allowed-ids`",
		isbeta: "config.isbeta",
		type_emojis: "config.emojis",
		emoji_filtering: "config.emoji_filtering",
	},
	meta: {
		_message_cache: "meta.`_message_cache`",
		"sender-channel": "meta.`sender-channel`",
		trigger: "meta.trigger",
		sender: "meta.sender",
		type_read: "meta.read",
		read: {
			discord: "meta.read.discord",
			guilded: "meta.read.guilded",
			revolt: "meta.read.revolt",
			nerimity: "meta.read.nerimity",
		},
		type_message: "meta.message",
		message: {
			type_reply: "meta.message.reply",
			isReply: "meta.message.isReply",
			reply: {
				message: "meta.message.reply.message",
				author: "meta.message.reply.author",
			},
			type_author: "meta.message.author",
			author: {
				name: "meta.message.author.name",
				avatar: "meta.message.author.avatar",
				id: "meta.message.author.id",
			},
			content: "meta.message.content",
			attachments: "meta.message.attachments",
		},
	},
};

export const healthyEndpointData = {
	config: {
		"self-user": false,
		webhooks: {
			discord: [],
			guilded: [],
			revolt: [],
			nerimity: [],
		},
		channels: {
			discord: [],
			guilded: [],
			revolt: [],
			nerimity: [],
		},
		logs: {
			discord: null,
			guilded: null,
			revolt: null,
			nerimity: null,
		},
		blacklist: [],
		"allowed-ids": [],
		isbeta: false,
		emojis: [],
		emoji_filtering: false,
	},
	meta: {
		_message_cache: [],
		"sender-channel": null,
		trigger: false,
		sender: null,
		read: {
			discord: false,
			guilded: false,
			revolt: false,
			nerimity: false,
		},
		message: {
			isReply: false,
			reply: {
				message: null,
				author: null,
			},
			author: {
				name: null,
				avatar: null,
				id: null,
			},
			content: null,
			attachments: [],
		},
	},
};

export async function checkEndpoint(
	endpoint: bigint,
): Promise<boolean> {
    const db = await getDb();
	try {
        if (!db) throw new Error("Database not initialized");
        const { rows } = await db.query(
            "SELECT data FROM endpoints WHERE id = $1",
            [endpoint.toString()]
        );
        if (rows.length === 0) {
            log("ERROR", `Endpoint '${endpoint}' not found`);
            return false;
        }
        const endpointData: Endpoint = rows[0].data;
        
		if (!endpointData.config || !endpointData.meta) {
			log("ERROR", `Endpoint '${endpoint}' has invalid structure (missing config or meta)`);
			return false;
		}
		for (const key of Object.keys(healthyEndpointData.config)) {
			if (!(key in endpointData.config)) {
				log("ERROR", `Config key '${key}' not found in endpoint '${endpoint}'`);
			}
		}
		for (const key of Object.keys(healthyEndpointData.meta)) {
			if (!(key in endpointData.meta)) {
				log("ERROR", `Meta key '${key}' not found in endpoint '${endpoint}'`);
			}
		}
		log("SUCCESS", `Endpoint ${endpoint} is healthy`);
		return true;
	} catch (e) {
		log("ERROR", `Error checking endpoint ${endpoint}: ${e}`);
		return false;
	} finally {
		db.release();
	}
}

export async function repairEndpointStructure(
	endpoint: bigint
): Promise<string[]> {
	const healthy = {
		config: {
			"self-user": false,
			type_webhooks: {},
			webhooks: {
				discord: [],
				guilded: [],
				revolt: [],
				nerimity: [],
			},
			type_channels: {},
			channels: {
				discord: [],
				guilded: [],
				revolt: [],
				nerimity: [],
			},
			type_logs: {},
			logs: {
				discord: "NULL",
				guilded: "NULL",
				revolt: "NULL",
				nerimity: "NULL",
			},
			blacklist: [],
			"allowed-ids": [],
			isbeta: false,
			type_emojis: [],
			emoji_filtering: false,
		},
		meta: {
			_message_cache: [],
			"sender-channel": "NULL",
			trigger: false,
			sender: "NULL",
			type_read: {},
			read: {
				discord: false,
				guilded: false,
				revolt: false,
				nerimity: false,
			},
			type_message: {},
			message: {
				isReply: false,
				type_reply: {},
				reply: {
					message: "NULL",
					author: "NULL",
				},
				type_author: {},
				author: {
					name: "NULL",
					avatar: "NULL",
					id: "NULL",
				},
				content: "NULL",
				attachments: [],
			},
		},
	};
	const summary: string[] = [];
	const endpointData = await getEndpoint(endpoint);
    if (!endpointData) {
        log("ERROR", `Endpoint '${endpoint}' not found`);
        return ["Endpoint not found"];
    }
	function tryWrite(path: string, value: any, label: string) {
		summary.push(label);
		if (!endpointData || !endpointData.config) {
			log("ERROR", "endpointData or endpointData.config is undefined.");
			return;
		}
		let new_config = { ...endpointData.config };
		const pathParts = path.replace(/^config\./, "").replace(/`/g, "").split(".");
		let obj = new_config;
		for (let i = 0; i < pathParts.length - 1; i++) {
			if (!(pathParts[i] in obj)) obj[pathParts[i]] = {};
			obj = obj[pathParts[i]];
		}
		obj[pathParts[pathParts.length - 1]] = value;
		return updateEndpointConfig(endpoint, new_config);
	}
	if (!("self-user" in endpointData.config))
		await tryWrite(
			writes.config["self-user"],
			healthy.config["self-user"],
			"✘ Self user not found. Adding..."
		);
	if (!("webhooks" in endpointData.config))
		await tryWrite(
			writes.config.type_webhooks,
			healthy.config.type_webhooks,
			"✘ Webhooks not found. Adding..."
		);
	if (!endpointData.config.webhooks?.discord)
		await tryWrite(
			writes.config.webhooks.discord,
			healthy.config.webhooks.discord,
			"✘ Webhooks - Discord not found. Adding..."
		);
	if (!endpointData.config.webhooks?.guilded)
		await tryWrite(
			writes.config.webhooks.guilded,
			healthy.config.webhooks.guilded,
			"✘ Webhooks - Guilded not found. Adding..."
		);
	if (!endpointData.config.webhooks?.revolt)
		await tryWrite(
			writes.config.webhooks.revolt,
			healthy.config.webhooks.revolt,
			"✘ Webhooks - Revolt not found. Adding..."
		);
	if (!endpointData.config.webhooks?.nerimity)
		await tryWrite(
			writes.config.webhooks.nerimity,
			healthy.config.webhooks.nerimity,
			"✘ Webhooks - Nerimity not found. Adding..."
		);
	if (!("channels" in endpointData.config))
		await tryWrite(
			writes.config.type_channels,
			healthy.config.type_channels,
			"✘ Channels not found. Adding..."
		);
	if (!endpointData.config.channels?.discord)
		await tryWrite(
			writes.config.channels.discord,
			healthy.config.channels.discord,
			"✘ Channels - Discord not found. Adding..."
		);
	if (!endpointData.config.channels?.guilded)
		await tryWrite(
			writes.config.channels.guilded,
			healthy.config.channels.guilded,
			"✘ Channels - Guilded not found. Adding..."
		);
	if (!endpointData.config.channels?.revolt)
		await tryWrite(
			writes.config.channels.revolt,
			healthy.config.channels.revolt,
			"✘ Channels - Revolt not found. Adding..."
		);
	if (!endpointData.config.channels?.nerimity)
		await tryWrite(
			writes.config.channels.nerimity,
			healthy.config.channels.nerimity,
			"✘ Channels - Nerimity not found. Adding..."
		);
	if (!("logs" in endpointData.config))
		await tryWrite(
			writes.config.type_logs,
			healthy.config.type_logs,
			"✘ Logs not found. Adding..."
		);
	if (!endpointData.config.logs?.discord)
		await tryWrite(
			writes.config.logs.discord,
			healthy.config.logs.discord,
			"✘ Logs - Discord not found. Adding..."
		);
	if (!endpointData.config.logs?.guilded)
		await tryWrite(
			writes.config.logs.guilded,
			healthy.config.logs.guilded,
			"✘ Logs - Guilded not found. Adding..."
		);
	if (!endpointData.config.logs?.revolt)
		await tryWrite(
			writes.config.logs.revolt,
			healthy.config.logs.revolt,
			"✘ Logs - Revolt not found. Adding..."
		);
	if (!endpointData.config.logs?.nerimity)
		await tryWrite(
			writes.config.logs.nerimity,
			healthy.config.logs.nerimity,
			"✘ Logs - Nerimity not found. Adding..."
		);
	if (!("blacklist" in endpointData.config))
		await tryWrite(
			writes.config.blacklist,
			healthy.config.blacklist,
			"✘ Blacklist not found. Adding..."
		);
	if (!("allowed-ids" in endpointData.config))
		await tryWrite(
			writes.config["allowed-ids"],
			healthy.config["allowed-ids"],
			"✘ Allowed IDs not found. Adding..."
		);
	if (!("isbeta" in endpointData.config))
		await tryWrite(
			writes.config.isbeta,
			healthy.config.isbeta,
			"✘ IsBeta not found. Adding..."
		);
	if (!("emojis" in endpointData.config))
		await tryWrite(
			writes.config.type_emojis,
			healthy.config.type_emojis,
			"✘ Emojis not found. Adding..."
		);
	if (!("emoji_filtering" in endpointData.config))
		await tryWrite(
			writes.config.emoji_filtering,
			healthy.config.emoji_filtering,
			"✘ Emoji Filtering not found. Adding..."
		);

	if (!("_message_cache" in endpointData.meta))
		await tryWrite(
			writes.meta._message_cache,
			healthy.meta._message_cache,
			"✘ Message Cache not found. Adding..."
		);
	if (!("sender-channel" in endpointData.meta))
		await tryWrite(
			writes.meta["sender-channel"],
			healthy.meta["sender-channel"],
			"✘ Meta - Sender Channel not found. Adding..."
		);
	if (!("trigger" in endpointData.meta))
		await tryWrite(
			writes.meta.trigger,
			healthy.meta.trigger,
			"✘ Meta - Trigger not found. Adding..."
		);
	if (!("sender" in endpointData.meta))
		await tryWrite(
			writes.meta.sender,
			healthy.meta.sender,
			"✘ Meta - Sender not found. Adding..."
		);
	if (!("read" in endpointData.meta))
		await tryWrite(
			writes.meta.type_read,
			healthy.meta.type_read,
			"✘ Meta - Read not found. Adding..."
		);
	if (!endpointData.meta.read?.discord)
		await tryWrite(
			writes.meta.read.discord,
			healthy.meta.read.discord,
			"✘ Meta - Read - Discord not found. Adding..."
		);
	if (!endpointData.meta.read?.guilded)
		await tryWrite(
			writes.meta.read.guilded,
			healthy.meta.read.guilded,
			"✘ Meta - Read - Guilded not found. Adding..."
		);
	if (!endpointData.meta.read?.revolt)
		await tryWrite(
			writes.meta.read.revolt,
			healthy.meta.read.revolt,
			"✘ Meta - Read - Revolt not found. Adding..."
		);
	if (!endpointData.meta.read?.nerimity)
		await tryWrite(
			writes.meta.read.nerimity,
			healthy.meta.read.nerimity,
			"✘ Meta - Read - Nerimity not found. Adding..."
		);
	if (!("message" in endpointData.meta))
		await tryWrite(
			writes.meta.type_message,
			healthy.meta.type_message,
			"✘ Meta - Message not found. Adding..."
		);
	if (!endpointData.meta.message?.isReply)
		await tryWrite(
			writes.meta.message.isReply,
			healthy.meta.message.isReply,
			"✘ Meta - Message - IsReply not found. Adding..."
		);
	if (!endpointData.meta.message?.reply)
		await tryWrite(
			writes.meta.message.type_reply,
			healthy.meta.message.type_reply,
			"✘ Meta - Message - Reply not found. Adding..."
		);
	if (!endpointData.meta.message?.reply?.message)
		await tryWrite(
			writes.meta.message.reply.message,
			healthy.meta.message.reply.message,
			"✘ Meta - Message - Reply - Message not found. Adding..."
		);
	if (!endpointData.meta.message?.reply?.author)
		await tryWrite(
			writes.meta.message.reply.author,
			healthy.meta.message.reply.author,
			"✘ Meta - Message - Reply - Author not found. Adding..."
		);
	if (!endpointData.meta.message?.author)
		await tryWrite(
			writes.meta.message.type_author,
			healthy.meta.message.type_author,
			"✘ Meta - Message - Author not found. Adding..."
		);
	if (!endpointData.meta.message?.author?.name)
		await tryWrite(
			writes.meta.message.author.name,
			healthy.meta.message.author.name,
			"✘ Meta - Message - Author - Name not found. Adding..."
		);
	if (!endpointData.meta.message?.author?.avatar)
		await tryWrite(
			writes.meta.message.author.avatar,
			healthy.meta.message.author.avatar,
			"✘ Meta - Message - Author - Avatar not found. Adding..."
		);
	if (!endpointData.meta.message?.author?.id)
		await tryWrite(
			writes.meta.message.author.id,
			healthy.meta.message.author.id,
			"✘ Meta - Message - Author - ID not found. Adding..."
		);
	if (!endpointData.meta.message?.content)
		await tryWrite(
			writes.meta.message.content,
			healthy.meta.message.content,
			"✘ Meta - Message - Content not found. Adding..."
		);
	if (!endpointData.meta.message?.attachments)
		await tryWrite(
			writes.meta.message.attachments,
			healthy.meta.message.attachments,
			"✘ Meta - Message - Attachments not found. Adding..."
		);
	log("SUCCESS", `Endpoint structure repaired for ${endpoint}`);
	return summary;
}

export async function dailyCheck(): Promise<string[]> {
	const endpoints = await getAllEndpoints();
	const summary: string[] = [];
	const total = endpoints.length;
	for (let i = 0; i < endpoints.length; i++) {
		const endpoint = endpoints[i];
		log(
			"INFO",
			`[Daily Endpoint Check] Checking ${endpoint} | ${i + 1}/${total}`
		);
		try {
			const isHealthy = await checkEndpoint(
				BigInt(endpoint)
			);
			if (isHealthy) {
				summary.push(`${endpoint} | Healthy`);
			}
		} catch {
			const endpointSummary = await repairEndpointStructure(
				BigInt(endpoint)
			);
			summary.push(`${endpoint} | ${endpointSummary.join(" | ")}`);
		}
		await new Promise((res) => setTimeout(res, 400));
	}
	return summary;
}
