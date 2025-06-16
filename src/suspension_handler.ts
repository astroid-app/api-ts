import { getDb } from "./utils/surrealdb";
import { StringRecordId, jsonify, r} from "surrealdb";
import Surreal from "surrealdb";
import { DEFAULT_CONFIG, DEFAULT_AUTH } from "./utils/surrealdb";

////tests
//get_suspend_data("188563418570031104").then((result) => {console.log(result);}).catch((err) => {console.error(err);});
//is_suspended("1232").then((result) => {console.log(result);}).catch((err) => {console.error(err);});
//suspend("1232", "test", "test", 1).then((result) => {console.log(result);}).catch((err) => {console.error(err);});
//test()
//unsuspend("1232")
//async function test() {console.log(await get_suspend_data("1232"));}

///////////

export async function is_suspended(endpoint_id:String): Promise<boolean> {

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

export async function suspend(endpoint_id:String, reason:String, suspended_by:String, expireInDays?:number) {
    const suspendedAt = new Date();

    const suspension: any = {
        id: endpoint_id,
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

export async function unsuspend(endpoint_id:String) {
    try {
        const db = await connectToDatabase();
        await db.merge(new StringRecordId(`suspensions:⟨${endpoint_id}⟩`), {
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

async function get_suspend_data(endpoint_id:String): Promise<any> {
    try {
    const db = await getDb();
    const result = await db.select(new StringRecordId(`suspensions:⟨${endpoint_id}⟩`));
    const jsonresult = jsonify(result);
    return jsonresult;
    
    }catch (err) {}
}
