import { getDb } from "./utils/pgsql";
import { getDb as getSurrealDb } from "./utils/surrealdb";
import log from "./utils/logger";

export type MigrateEndpointsOptions = {
	dryRun?: boolean;
	overwriteExisting?: boolean;
	limit?: number;
	migrateOutOfRangeToOverflow?: boolean;
};

export type MigrateEndpointsSummary = {
	tokensMigrated: number;
	totalSurrealRecords: number;
	processed: number;
	inserted: number;
	updated: number;
	skippedExisting: number;
	skippedInvalid: number;
	skippedOutOfRange: number;
	overflowInserted: number;
	overflowUpdated: number;
	errors: number;
	dryRun: boolean;
	overwriteExisting: boolean;
	migrateOutOfRangeToOverflow: boolean;
	limit: number | null;
};

const PG_BIGINT_MIN = -(2n ** 63n);
const PG_BIGINT_MAX = (2n ** 63n) - 1n;

const OVERFLOW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS endpoints_overflow (
	id_text text PRIMARY KEY,
	data jsonb NOT NULL,
	migrated_at timestamptz NOT NULL DEFAULT now()
)
`;

function parseEndpointId(raw: unknown): bigint | null {
	if (typeof raw === "bigint") return raw;
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
		return BigInt(raw);
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
		const matched = trimmed.match(/(\d+)/);
		if (matched?.[1]) return BigInt(matched[1]);
		return null;
	}
	if (raw && typeof raw === "object") {
		const maybe = raw as { id?: unknown };
		if (maybe.id !== undefined) return parseEndpointId(maybe.id);
	}
	return null;
}

function extractEndpointData(record: unknown): unknown | null {
	if (!record || typeof record !== "object") return null;
	const maybe = record as { data?: unknown };
	if (maybe.data !== undefined) return maybe.data;
	return record;
}

function serializeForJsonb(value: unknown): string {
	return JSON.stringify(value, (_key, innerValue) => {
		if (typeof innerValue === "bigint") {
			return innerValue.toString();
		}
		return innerValue;
	});
}

export async function migrateEndpointsFromSurrealToPostgres(
	options: MigrateEndpointsOptions = {}
): Promise<MigrateEndpointsSummary> {
	const dryRun = !!options.dryRun;
	const overwriteExisting = !!options.overwriteExisting;
	const migrateOutOfRangeToOverflow =
		options.migrateOutOfRangeToOverflow !== undefined
			? !!options.migrateOutOfRangeToOverflow
			: true;
	const limit =
		typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
			? Math.floor(options.limit)
			: null;

	const summary: MigrateEndpointsSummary = {
		tokensMigrated: 0,
		totalSurrealRecords: 0,
		processed: 0,
		inserted: 0,
		updated: 0,
		skippedExisting: 0,
		skippedInvalid: 0,
		skippedOutOfRange: 0,
		overflowInserted: 0,
		overflowUpdated: 0,
		errors: 0,
		dryRun,
		overwriteExisting,
		migrateOutOfRangeToOverflow,
		limit,
	};

	const sdb = await getSurrealDb();
	const pg = await getDb();

	try {
		const surrealResult = (await sdb.select("endpoints")) as unknown[];
		summary.totalSurrealRecords = Array.isArray(surrealResult) ? surrealResult.length : 0;
		const records = limit ? surrealResult.slice(0, limit) : surrealResult;

		if (!dryRun) {
			await pg.query("BEGIN");
			if (migrateOutOfRangeToOverflow) {
				await pg.query(OVERFLOW_TABLE_SQL);
			}
		}

		for (const record of records) {
			const id = parseEndpointId(record);
			const data = extractEndpointData(record);

			if (!id || data === null) {
				summary.skippedInvalid += 1;
				continue;
			}

			if (id < PG_BIGINT_MIN || id > PG_BIGINT_MAX) {
				if (!migrateOutOfRangeToOverflow) {
					summary.skippedOutOfRange += 1;
					log(
						"WARN",
						`Skipping endpoint ${id.toString()} because it is out of PostgreSQL bigint range`
					);
					continue;
				}

				try {
					if (!dryRun) {
						await pg.query("SAVEPOINT migrate_endpoint_overflow_row");
					}

					const serializedData = serializeForJsonb(data);
					const overflowExistsRes = await pg.query(
						"SELECT 1 FROM endpoints_overflow WHERE id_text = $1",
						[id.toString()]
					);
					const overflowExists = overflowExistsRes.rows.length > 0;

					if (dryRun) {
						if (overflowExists) {
							if (overwriteExisting) summary.overflowUpdated += 1;
							else summary.skippedExisting += 1;
						} else {
							summary.overflowInserted += 1;
						}
						continue;
					}

					if (!overflowExists) {
						await pg.query(
							"INSERT INTO endpoints_overflow (id_text, data) VALUES ($1, $2::jsonb)",
							[id.toString(), serializedData]
						);
						summary.overflowInserted += 1;
					} else if (overwriteExisting) {
						await pg.query(
							"UPDATE endpoints_overflow SET data = $2::jsonb, migrated_at = now() WHERE id_text = $1",
							[id.toString(), serializedData]
						);
						summary.overflowUpdated += 1;
					} else {
						summary.skippedExisting += 1;
					}

					if (!dryRun) {
						await pg.query("RELEASE SAVEPOINT migrate_endpoint_overflow_row");
					}
				} catch (e) {
					if (!dryRun) {
						try {
							await pg.query("ROLLBACK TO SAVEPOINT migrate_endpoint_overflow_row");
							await pg.query("RELEASE SAVEPOINT migrate_endpoint_overflow_row");
						} catch {
							// ignore rollback-to-savepoint errors and keep summary accounting
						}
					}
					summary.errors += 1;
					log("ERROR", `Failed migrating out-of-range endpoint ${id.toString()}: ${String(e)}`);
				}

				continue;
			}

			summary.processed += 1;

			try {
				if (!dryRun) {
					await pg.query("SAVEPOINT migrate_endpoint_row");
				}

				const serializedData = serializeForJsonb(data);
				const existsRes = await pg.query("SELECT 1 FROM endpoints WHERE id = $1", [
					id.toString(),
				]);
				const exists = existsRes.rows.length > 0;

				if (dryRun) {
					if (exists) {
						if (overwriteExisting) summary.updated += 1;
						else summary.skippedExisting += 1;
					} else {
						summary.inserted += 1;
					}
					continue;
				}

				if (!exists) {
					await pg.query("INSERT INTO endpoints (id, data) VALUES ($1, $2::jsonb)", [
						id.toString(),
						serializedData,
					]);
					summary.inserted += 1;
					if (!dryRun) {
						await pg.query("RELEASE SAVEPOINT migrate_endpoint_row");
					}
					continue;
				}

				if (overwriteExisting) {
					await pg.query("UPDATE endpoints SET data = $2::jsonb WHERE id = $1", [
						id.toString(),
						serializedData,
					]);
					summary.updated += 1;
				} else {
					summary.skippedExisting += 1;
				}

				if (!dryRun) {
					await pg.query("RELEASE SAVEPOINT migrate_endpoint_row");
				}
			} catch (e) {
				if (!dryRun) {
					try {
						await pg.query("ROLLBACK TO SAVEPOINT migrate_endpoint_row");
						await pg.query("RELEASE SAVEPOINT migrate_endpoint_row");
					} catch {
						// ignore rollback-to-savepoint errors and keep summary accounting
					}
				}

				summary.errors += 1;
				log("ERROR", `Failed migrating endpoint ${id.toString()}: ${String(e)}`);
			}
		}

		if (!dryRun) {
			if (summary.errors > 0) {
				await pg.query("ROLLBACK");
			} else {
				await pg.query("COMMIT");
			}
		}

		log(
			"INFO",
			`Endpoint migration complete: processed=${summary.processed}, inserted=${summary.inserted}, updated=${summary.updated}, overflowInserted=${summary.overflowInserted}, overflowUpdated=${summary.overflowUpdated}, skippedExisting=${summary.skippedExisting}, skippedInvalid=${summary.skippedInvalid}, skippedOutOfRange=${summary.skippedOutOfRange}, errors=${summary.errors}, dryRun=${summary.dryRun}`
		);
		return summary;
	} finally {
		try {
			await sdb.close();
		} catch {
			// ignore close failures
		}
		pg.release();
	}
}
