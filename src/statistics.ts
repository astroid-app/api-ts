import { getDb } from "./utils/surrealdb";
import { RecordId, jsonify} from "surrealdb";

export async function roundStatistics(): Promise<any> {

    const db = await getDb();
    try {
        const result = await db.select(new RecordId("statistics", "messages"));
        const endpointResult = await db.select("endpoints");
        const jsonEndpointResult = jsonify(endpointResult) as any[];
        const jsonresult = jsonify(result) as Record<string, any>;

        const totalMessages = Number(jsonresult?.total ?? 0);
        const monthlyMasages = Number(jsonresult?.month ?? 0);

        const totalMessagesRounded = round(totalMessages);
        const monthlyMasagesRounded = round(monthlyMasages);

        const endpoints = Array.isArray(jsonEndpointResult)
            ? jsonEndpointResult.length
            : 0;

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