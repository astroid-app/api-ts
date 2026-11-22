import { getDb } from "./utils/surrealdb";
import { getDb as getPgDb } from "./utils/pgsql";
import { RecordId, jsonify} from "surrealdb";
import log from "./utils/logger";

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
            db.select(new RecordId("statistics", "messages")),
            countEndpoints(),
        ]);
        const jsonresult = jsonify(result) as Record<string, any>;

        const totalMessages = Number(jsonresult?.total ?? 0);
        const monthlyMasages = Number(jsonresult?.month ?? 0);

        const totalMessagesRounded = round(totalMessages);
        const monthlyMasagesRounded = round(monthlyMasages);

        const stats = {
            messages: {
                id: jsonresult?.id ?? "statistics:messages",
                month: monthlyMasages,
                periodStart: jsonresult?.periodStart ?? null,
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
 * Increments the message counters in statistics:messages. The monthly counter
 * resets on the 1st of each calendar month (UTC): the first message whose
 * month/year differs from periodStart's starts a new period. Runs as a single
 * transaction so concurrent messages don't lose increments.
 */
export async function incrementMessageStatistics(increment: number = 1): Promise<void> {
    const db = await getDb();
    try {
        await db.query(
            `BEGIN TRANSACTION;
            LET $now = time::now();
            IF array::len(SELECT id FROM statistics:messages) = 0 {
                CREATE statistics:messages SET total = 0, month = 0, periodStart = time::unix($now);
            };
            LET $start = (SELECT VALUE periodStart FROM statistics:messages)[0];
            -- periodStart may be a float (older writers stored fractional
            -- seconds); a bare <int> cast of a fractional float throws and
            -- aborts the whole transaction, so floor it first.
            LET $reset = IF type::is::number($start) THEN
                    time::year(time::from::unix(<int> math::floor($start))) != time::year($now)
                    OR time::month(time::from::unix(<int> math::floor($start))) != time::month($now)
                ELSE true END;
            UPDATE statistics:messages SET
                month = IF $reset THEN $inc ELSE (month ?? 0) + $inc END,
                periodStart = IF $reset THEN time::unix($now) ELSE periodStart END,
                total = (total ?? 0) + $inc;
            COMMIT TRANSACTION;`,
            { inc: increment }
        );
    } catch (err) {
        log("ERROR", "Failed to increment message statistics:", err instanceof Error ? err.message : String(err));
        throw err;
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