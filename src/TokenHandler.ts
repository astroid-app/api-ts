import { Token } from "./types/Token";
import { getTokenDb } from "./utils/surrealdb";
import { jsonify, RecordId } from "surrealdb";
import log from "./utils/logger";
import { health } from "./utils/health";

async function getTokens(endpointId: bigint): Promise<Token | undefined> {
	const db = await getTokenDb();
	if (!db) {
		log("ERROR", "Database not initialized");
		return undefined;
	}
	try {
		var token = await db.select(new RecordId("tokens", `⟨${endpointId}⟩`));
		log("INFO", "Tokens found:", endpointId);
		var tokenData = jsonify(token) as unknown as Token;
		delete tokenData.id;
		return tokenData;
	} catch (err) {
		log("ERROR", "Failed to get token:", err);
		return undefined;
	} finally {
		await db.close();
	}
}

export function validateToken(
	endpointId: bigint,
	token: string
): Promise<boolean> {
	if (token === process.env.MASTER_TOKEN) {
		log("DEBUG", `Validating master token for endpoint: ${endpointId}`);
		return Promise.resolve(true);
	} else {
		log("DEBUG", `Validating user token for endpoint: ${endpointId}`);
		let tokens = getTokens(endpointId);
		if (!tokens) {
			log("ERROR", "No tokens found for endpoint:", endpointId);
			return Promise.resolve(false);
		}
		return new Promise((resolve, reject) => {
			tokens
				.then((tokenData) => {
					if (!tokenData) {
						log("ERROR", "No tokens found for endpoint:", endpointId);
						resolve(false);
					} else {
						const tokenList = tokenData.tokens;
						if (tokenList && tokenList.includes(token)) {
							resolve(true);
						} else {
							health.increment("auth_errors");
							resolve(false);
						}
					}
				})
				.catch((err) => {
					log("ERROR", "Error getting tokens:", err);
					health.increment("auth_errors");
					reject(err);
				});
		});
	}
}
