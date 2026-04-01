import { getDb } from "./utils/surrealdb";
import { StringRecordId, jsonify, r} from "surrealdb";
import Surreal from "surrealdb";
import { DEFAULT_CONFIG, DEFAULT_AUTH } from "./utils/surrealdb";

export async function is_suspended(endpoint_id: bigint): Promise<boolean> {

    const endpoint = await get_suspend_data(endpoint_id);

    if (!endpoint) {
        return false;
    }
    try {
        if (endpoint.suspended === false) {
            return false;
        }
    }catch (err) {}
    try {
        if (endpoint.decaytime) {
            const now = new Date();
            const expireDate = new Date(endpoint.decaytime);
            if (now > expireDate) {
                unsuspend(endpoint_id);
                return false;
            }  
        }
    }catch (err) {}
    return true
}

export async function suspend(endpoint_id: bigint, reason: string, suspended_by: string, expireInDays?: number) {
    const suspendedAt = new Date();

    const suspension: any = {
        id: endpoint_id.toString(),
        reason: reason,
        suspended: true,
        suspendedAt: suspendedAt.toISOString(),
        suspendedBy: suspended_by,
    };

    if (expireInDays !== undefined) {
        const expireDate = new Date();
        expireDate.setDate(suspendedAt.getDate() + expireInDays);
        suspension.decaytime = expireDate.toISOString();
    }
    try {
        const db = await connectToDatabase();
        await db.create("suspensions", suspension);
    } catch (err) {}

}

export async function unsuspend(endpoint_id: bigint) {
    try {
        const db = await connectToDatabase();
        await db.merge(new StringRecordId(`suspensions:⟨${endpoint_id.toString()}⟩`), {
            suspended: false,
        });
    }catch (err) {}
}

async function connectToDatabase(): Promise<any> {
    const auth = {
      namespace: DEFAULT_CONFIG.namespace,
      database: DEFAULT_CONFIG.database,
      auth: {      
        username: DEFAULT_AUTH.username,
        password: DEFAULT_AUTH.password,
      }
    };
    try {
    const db = new Surreal();
    await db.connect(DEFAULT_CONFIG.url,auth);
    return db;
    }catch (err) {}
}

async function get_suspend_data(endpoint_id: bigint): Promise<any> {
    try {
    const db = await getDb();
    const result = await db.select(new StringRecordId(`suspensions:⟨${endpoint_id.toString()}⟩`));
    const jsonresult = jsonify(result);
    return jsonresult;
    
    }catch (err) {}
}
