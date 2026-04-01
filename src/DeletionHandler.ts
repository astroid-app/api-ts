import { getDb } from "./utils/pgsql";
import { getTokenDb } from "./utils/surrealdb";
import { RecordId } from "surrealdb";

export async function deleteEndpointAndToken(endpointId: bigint): Promise<boolean> {
    const db = await getDb();
    if (!db) return false;
    try {
        await db.query("DELETE FROM endpoints WHERE id = $1", [endpointId.toString()]);
    } finally {
        db.release();
    }
    const tokenDb = await getTokenDb();
    if (!tokenDb) return false;
    await tokenDb.delete(new RecordId("tokens", endpointId));
    await tokenDb.close();
    return true;
}

export async function deleteToken(endpointId: bigint, token: string): Promise<boolean> {
    const tokenDb = await getTokenDb();
    if (!tokenDb) return false;
    const record = await tokenDb.select(new RecordId("tokens", endpointId));
    if (!record || !Array.isArray(record.tokens)) return false;
    const tokens = record.tokens.filter((t: string) => t !== token);
    await tokenDb.update(new RecordId("tokens", endpointId), { tokens });
    await tokenDb.close();
    return true;
}
