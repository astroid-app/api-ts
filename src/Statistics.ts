import { getDb } from "./utils/surrealdb";
import { getDb as getPgDb } from "./utils/pgsql";
import { RecordId, jsonify} from "surrealdb";
import log from "./utils/logger";

/**
 * Statistics live in the SurrealDB `statistics` table:
 *  - statistics:messages        -> Astroid-wide counters (total, month, periodStart)
 *  - statistics:⟨<endpointId>⟩  -> per-endpoint counters (total, month, periodStart,
 *                                  platforms: messages sent from each platform)
 *
 * `periodStart` is the unix timestamp (seconds) of 00:00 UTC on the 1st of the
 * month the `month` counter belongs to. The first message of a new month resets it.
 */

export const STAT_PLATFORMS = ["discord", "guilded", "nerimity", "revolt"] as const;
export type StatPlatform = (typeof STAT_PLATFORMS)[number];

const GLOBAL_STATS_ID = "messages";

function endpointStatsId(endpointId: bigint): RecordId {
    return new RecordId("statistics", endpointId.toString());
}

/** Unix seconds of 00:00 UTC on the 1st of the current month. */
function currentMonthStart(now: Date = new Date()): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
}

/** A stored month counter only counts if its period is the current month. */
function monthValue(record: Record<string, any> | undefined, monthStart: number): number {
    const start = Number(record?.periodStart);
    if (!Number.isFinite(start) || start < monthStart) return 0;
    return Number(record?.month ?? 0);
}

async function countEndpoints(): Promise<number> {
    const pg = await getPgDb();
    try {
        const { rows } = await pg.query("SELECT COUNT(*)::int AS total FROM endpoints");
        return Number(rows[0]?.total ?? 0);
    } finally {
        pg.release();
    }
}

export async function roundStatistics(): Promise<any> {

    const db = await getDb();
    try {
        const [result, endpoints] = await Promise.all([
            db.select(new RecordId("statistics", GLOBAL_STATS_ID)),
            countEndpoints(),
        ]);
        const jsonresult = jsonify(result) as Record<string, any>;
        const monthStart = currentMonthStart();

        const totalMessages = Number(jsonresult?.total ?? 0);
        const monthlyMasages = monthValue(jsonresult, monthStart);

        const totalMessagesRounded = round(totalMessages);
        const monthlyMasagesRounded = round(monthlyMasages);

        const stats = {
            messages: {
                id: jsonresult?.id ?? "statistics:messages",
                month: monthlyMasages,
                periodStart: monthStart,
                total: totalMessages,
                total_rounded: totalMessagesRounded,
                month_rounded: monthlyMasagesRounded
            },
            endpoints: endpoints
        };

        return stats;
    } finally {
        await db.close();
    }
}

/**
 * Statistics for a single endpoint: message totals, this month's count
 * (reset on the 1st, UTC) and the share of messages sent from each platform.
 */
export async function getEndpointStatistics(endpointId: bigint): Promise<any> {
    const db = await getDb();
    try {
        const record = jsonify(await db.select(endpointStatsId(endpointId))) as
            | Record<string, any>
            | undefined;
        const monthStart = currentMonthStart();

        const counts: Record<string, number> = {};
        for (const platform of STAT_PLATFORMS) {
            counts[platform] = Number(record?.platforms?.[platform] ?? 0);
        }
        const platformTotal = Object.values(counts).reduce((a, b) => a + b, 0);

        const percent: Record<string, number> = {};
        for (const platform of STAT_PLATFORMS) {
            percent[platform] = platformTotal > 0
                ? Math.round((counts[platform] / platformTotal) * 10000) / 100
                : 0;
        }

        return {
            endpoint: endpointId.toString(),
            messages: {
                total: Number(record?.total ?? 0),
                month: monthValue(record, monthStart),
                periodStart: monthStart,
            },
            platforms: {
                counts,
                percent,
            },
        };
    } finally {
        await db.close();
    }
}

/**
 * Counts one distributed message for Astroid's global statistics and for the
 * endpoint's own statistics (including which platform it was sent from).
 * Both records are updated in one transaction so concurrent messages never
 * lose increments.
 */
export async function incrementMessageStatistics(
    endpointId: bigint,
    platform: string | null | undefined,
    increment: number = 1
): Promise<void> {
    const knownPlatform = STAT_PLATFORMS.includes(platform as StatPlatform)
        ? (platform as StatPlatform)
        : null;
    if (!knownPlatform) {
        log("WARN", `Statistics: unknown sender platform '${platform}' for endpoint ${endpointId}, not counted per platform`);
    }

    const db = await getDb();
    try {
        await db.query(
            `BEGIN TRANSACTION;
            LET $g = type::thing("statistics", $globalId);
            LET $e = type::thing("statistics", $endpointId);
            LET $gStart = $g.periodStart;
            LET $eStart = $e.periodStart;
            LET $gNew = !type::is::number($gStart) OR $gStart < $monthStart;
            LET $eNew = !type::is::number($eStart) OR $eStart < $monthStart;
            UPSERT $g SET
                month = IF $gNew THEN $inc ELSE (month ?? 0) + $inc END,
                periodStart = IF $gNew THEN $monthStart ELSE periodStart END,
                total = (total ?? 0) + $inc;
            UPSERT $e SET
                endpoint = $endpointId,
                month = IF $eNew THEN $inc ELSE (month ?? 0) + $inc END,
                periodStart = IF $eNew THEN $monthStart ELSE periodStart END,
                total = (total ?? 0) + $inc,
                platforms = {
                    discord:  (platforms.discord  ?? 0) + IF $platform = "discord"  THEN $inc ELSE 0 END,
                    guilded:  (platforms.guilded  ?? 0) + IF $platform = "guilded"  THEN $inc ELSE 0 END,
                    nerimity: (platforms.nerimity ?? 0) + IF $platform = "nerimity" THEN $inc ELSE 0 END,
                    revolt:   (platforms.revolt   ?? 0) + IF $platform = "revolt"   THEN $inc ELSE 0 END
                };
            COMMIT TRANSACTION;`,
            {
                globalId: GLOBAL_STATS_ID,
                endpointId: endpointId.toString(),
                platform: knownPlatform,
                monthStart: currentMonthStart(),
                inc: increment,
            }
        );
    } catch (err) {
        log("ERROR", "Failed to increment message statistics:", err instanceof Error ? err.message : String(err));
        throw err;
    } finally {
        await db.close();
    }
}

/** Removes an endpoint's statistics record (global statistics are kept). */
export async function deleteEndpointStatistics(endpointId: bigint): Promise<void> {
    const db = await getDb();
    try {
        await db.delete(endpointStatsId(endpointId));
    } finally {
        await db.close();
    }
}

function round(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    let roundLimit = 2;
    const digits = Math.floor(Math.log10(value)) + 1;

    if (value < 10) {
        return value;
    }
    if (digits <= 2) {
        roundLimit = 1;
    }
    if (digits >= 6) {
        roundLimit = 3;
    }
    if (digits >= 9) {
        roundLimit = 4;
    }
    const factor = Math.pow(10, digits - roundLimit);
    return Math.floor(value / factor) * factor;
}
