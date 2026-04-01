import { getDb } from "./utils/pgsql";
import { Endpoint } from "./types/Endpoint";
import log from "./utils/logger";
import { getDb as getSDb } from "./utils/surrealdb";
import { jsonify } from "surrealdb";

export async function getEndpoint(
	endpointId: bigint
): Promise<Endpoint | undefined> {
	const client = await getDb();
	if (!client) {
		log("ERROR", "Database not initialized");
		return undefined;
	}
	try {
		const result = await client.query(
			"SELECT data FROM endpoints WHERE id = $1",
			[endpointId.toString()]
		);
		if (result.rows.length === 0) {
			log("ERROR", "No endpoint found with the given ID:", endpointId);
			return undefined;
		}

		if (result.rows.length > 0) {
			return result.rows[0].data as Endpoint;
		} else {
			log("ERROR", "There was an unexpected error while fetching the endpoint:", endpointId);
      log("DEBUG", "Unexpected result format:", result);
			return undefined;
		}
	} catch (err) {
		log("ERROR", "Error executing query:", err);
		return undefined;
	} finally {
		await client.release();
	}
}

export async function getAllEndpoints(): Promise<string[]> {
	const client = await getDb();
	if (!client) {
		log("ERROR", "Database not initialized");
		return [];
	}
	try {
		const result = await client.query("SELECT * FROM endpoints");
		return result.rows.map((row) => row.id);
	} catch (err) {
		log("ERROR", "Error executing query:", err);
		return [];
	} finally {
		await client.release();
	}
}

export async function getEndpointByPlatform(
	platform: string, serverid: string
): Promise<any> {
	const client = await getSDb();
	if (!client) {
		log("ERROR", "Database not initialized");
		return undefined;
	}
	try {
		log("DEBUG", `Fetching endpoint for platform: ${platform} and serverid: ${serverid}`);
		let result = await client.query(`SELECT discord FROM ${platform}_servers:${serverid}`);
		if (result.length === 0) {
			log("ERROR", `No endpoint found for platform: ${platform} and serverid: ${serverid}`);
			return undefined;
		}
		result = jsonify(result[0]) as any;
		return result[0]
	} catch (err) {
		log("ERROR", "Error executing query:", err);
		return undefined;
	}
}
