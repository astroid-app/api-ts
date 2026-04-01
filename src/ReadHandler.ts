import { getDb } from "./utils/pgsql";
import log from "./utils/logger";

const possiblePlatforms = ["discord", "guilded", "revolt", "nerimity"] as const;
type Platform = (typeof possiblePlatforms)[number] | "all";

export async function markRead(
	endpoint: bigint,
	platform: Platform
): Promise<boolean> {
	try {
		const db = await getDb();
		if (!db) throw new Error("Database not initialized");

		const { rows } = await db.query(
			"SELECT data->'meta'->'read' AS read FROM endpoints WHERE id = $1",
			[endpoint.toString()]
		);
		if (rows.length === 0) {
			log("ERROR", `Endpoint '${endpoint}' not found`);
			await db.release();
			return false;
		}

		let read = rows[0].read;
		if (platform !== "all") {
			if (!possiblePlatforms.includes(platform as any)) {
				throw new Error(`Invalid platform '${platform}'`);
			}
			if (read && read[platform]) {
				throw new Error(
					`Endpoint '${endpoint}' already marked as read for platform '${platform}'`
				);
			}
			await db.query(
				`UPDATE endpoints SET data = jsonb_set(data, '{meta,read,${platform}}', 'true', true) WHERE id = $1`,
				[endpoint.toString()]
			);
			await db.release();
		} else {
			const newRead: Record<string, boolean> = {};
			possiblePlatforms.forEach((p) => (newRead[p] = true));
			await db.query(
				`UPDATE endpoints SET data = jsonb_set(data, '{meta,read}', $2::jsonb, true) WHERE id = $1`,
				[endpoint.toString(), JSON.stringify(newRead)]
			);
			await db.release();
		}
		return true;
	} catch (error) {
		log("ERROR", `Error marking endpoint '${endpoint}' as read: ${error}`);
		return false;
	}
}

export async function checkRead(
	endpoint: bigint,
	platform: Platform = "all"
): Promise<boolean | Record<string, boolean>> {
	const db = await getDb();
	try {
		if (!db) throw new Error("Database not initialized");

		const { rows } = await db.query(
			"SELECT data->'meta' AS meta FROM endpoints WHERE id = $1",
			[endpoint.toString()]
		);

		if (rows.length > 0 && typeof rows[0].read === "string") {
			try {
				rows[0].read = JSON.parse(rows[0].read);
			} catch {
				rows[0].read = {};
			}
		}
		if (rows.length === 0) {
			log("ERROR", `Endpoint '${endpoint}' not found`);
			await db.release();
			return false;
		}

		const read = rows[0].read;
		if (platform !== "all") {
			if (!possiblePlatforms.includes(platform as any)) {
				await db.release();
				log("ERROR", `Invalid platform '${platform}'`);
				return false;
			}
			return read ? !!read[platform] : false;
		}
		return read || {};
	} catch (error) {
		log(
			"ERROR",
			`Error checking read status for endpoint '${endpoint}': ${error}`
		);
		return false;
	} finally {
		if (db) {
			try {
				await db.release();
			} catch (err) {
				log("ERROR", `Error releasing database connection: ${err}`);
			}
		}
	}
}
