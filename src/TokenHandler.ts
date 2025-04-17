import { Token } from "./types/Token";
import { getTokenDb } from "./utils/surrealdb";
import { jsonify, RecordId } from "surrealdb";

async function getTokens(endpointId: string): Promise<Token | undefined> {
    const db = await getTokenDb();
    if (!db) {
        console.error("Database not initialized");
        return undefined;
    }
    try {
        var token = await db.select(new RecordId("tokens", endpointId));
        console.log("Tokens found:", endpointId);
        var tokenData = jsonify(token) as unknown as Token;
        delete tokenData.id;
        return tokenData;
    } catch (err) {
        console.error("Failed to get token:", err);
        return undefined;
    } finally {
        await db.close();
    }
}

export function validateToken(endpointId: string, token: string): Promise<boolean> {
    let tokens = getTokens(endpointId);
    if (!tokens) {
        console.error("No tokens found for endpoint:", endpointId);
        return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
        tokens.then((tokenData) => {
            if (!tokenData) {
                console.error("No tokens found for endpoint:", endpointId);
                resolve(false);
            } else {
                const tokenList = tokenData.tokens;
                if (tokenList && tokenList.includes(token)) {
                    resolve(true);
                } else {
                    resolve(false);
                }
            }
        }).catch((err) => {
            console.error("Error getting tokens:", err);
            reject(err);
        });
    });
}
