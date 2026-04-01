import { getDb } from "./utils/pgsql";
import { getTokenDb } from "./utils/surrealdb";
import { RecordId } from "surrealdb";
import * as crypto from "crypto";
import { Endpoint } from "./types/Endpoint";
import log from "./utils/logger";

function generateUrlSafeToken(length: number = 71): string {
    // 71 chars base64url = 53 bytes (53*8/6 = 70.66)
    return crypto.randomBytes(53).toString("base64url").slice(0, length);
}

function getDefaultEndpoint(): Endpoint {
    return {
        config: {
            "allowed-ids": [],
            blacklist: [],
            channels: { discord: [], guilded: [], nerimity: [], revolt: [] },
            emoji_filtering: false,
            emojis: [],
            isbeta: false,
            logs: { discord: "", guilded: null, nerimity: null, revolt: null },
            "self-user": false,
            webhooks: { discord: [], guilded: [], nerimity: [], revolt: [] },
        },
        meta: {
            _message_cache: [],
            message: {
                attachments: [],
                author: { avatar: null, id: null, name: null },
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
                reply: { author: null, message: null },
                sender: null,
                "sender-channel": null,
            },
            read: { discord: false, guilded: false, nerimity: false, revolt: false },
            sender: null,
            "sender-channel": null,
            trigger: false,
        },
    };
}

export async function createEndpointAndToken(endpointId: bigint): Promise<{ endpointId: bigint; token: string } | null> {
    const token = generateUrlSafeToken();
    const db = await getDb();
    if (!db) return null;
    const defaultData = getDefaultEndpoint();
    const endpoint_exists = await db.query("SELECT * FROM endpoints WHERE id = $1", [endpointId.toString()]);
    const endpointExists = endpoint_exists.rows.length > 0;
    if (endpointExists) {
        log("ERROR", `Endpoint ${endpointId} already exists`);
        log("DEBUG", JSON.stringify(endpoint_exists.rows[0]));
        db.release();
        return { "endpointId": endpointId, "token": "exists" };
    }
    try {
        await db.query("INSERT INTO endpoints (id, data) VALUES ($1, $2)", [endpointId.toString(), JSON.stringify(defaultData)]);
    } finally {
        db.release();
    }
    const tokenDb = await getTokenDb();
    if (!tokenDb) return null;
    const record = await tokenDb.select(new RecordId("tokens", `⟨${endpointId}⟩`)).catch(() => null);
    if (!record) {
        await tokenDb.create(new RecordId("tokens", `⟨${endpointId}⟩`), { tokens: [token] }).catch((e) => {
            log("ERROR", `Failed to create token record for endpoint ${endpointId}: ${e}`);
            throw e;
        });
    } else {
        const existingTokens = Array.isArray(record.tokens) ? record.tokens : [];
        await tokenDb.update(new RecordId("tokens", `⟨${endpointId}⟩`), { tokens: [...existingTokens, token] }).catch((e) => {
            log("ERROR", `Failed to update token record for endpoint ${endpointId}: ${e}`);
            throw e;
        });
    }
    await tokenDb.close();
    return { endpointId, token };
}

export async function createNewToken(endpointId: bigint): Promise<string | null> {
    const token = generateUrlSafeToken();
    const tokenDb = await getTokenDb();
    if (!tokenDb) return null;
    const record = await tokenDb.select(new RecordId("tokens", `⟨${endpointId}⟩`)).catch(() => null);
    if (!record || !Array.isArray(record.tokens)) return null;
    const tokens = record.tokens;
    tokens.push(token);
    await tokenDb.update(new RecordId("tokens", `⟨${endpointId}⟩`), { tokens }).catch((e) => {
        log("ERROR", `Failed to update token record for endpoint ${endpointId}: ${e}`);
        throw e;
    });
    await tokenDb.close();
    return token;
}
