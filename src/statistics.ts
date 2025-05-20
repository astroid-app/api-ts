import { getDb } from "./utils/surrealdb";
import { RecordId, jsonify} from "surrealdb";

export async function roundStatistics(): Promise<any> {

    const db = await getDb();
    const result = await db.select(new RecordId("statistics", "messages"));
    const endpointResult = await db.select("endpoints");
    const jsonEndpointResult = jsonify(endpointResult);
    const jsonresult = jsonify(result); 
    const totalMessages = jsonresult.total as number;
    const monthlyMasages = jsonresult.month as number;

    const totalMessagesRounded = round(totalMessages);
    const monthlyMasagesRounded = round(monthlyMasages);

    const endpoints = jsonEndpointResult.length;

    // object construction for return
    const stats = {
        messages: {
            id: jsonresult.id,
            month: monthlyMasages,
            periodStart: jsonresult.periodStart,
            total: totalMessages,
            total_rounded: totalMessagesRounded,
            month_rounded: monthlyMasagesRounded
        },
        endpoints: endpoints
    };

    return stats;
}

// This function rounds a number based on its magnitude.
function round(value: number): number {
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