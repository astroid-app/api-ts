import { getDb } from "./utils/pgsql";
import { Endpoint } from "./types/Endpoint";

export async function getEndpoint(endpointId: string): Promise<Endpoint | undefined> {
  const client = await getDb();
  if (!client) {
    console.error("Database not initialized");
    return undefined;
  }
  try {
    const result = await client.query('SELECT data FROM endpoints WHERE id = $1', [endpointId]);
    if (result.rows.length === 0) {
      return undefined; // No endpoint found with the given ID
    }

    if (result.rows.length > 0) {
        return result.rows[0].data as Endpoint; // Return the first endpoint found
    } else {
        return undefined; // No endpoint found with the given ID
    }
} catch (err) {
    console.error('Error executing query:', err);
    return undefined; // Handle the error as needed
} finally {
    await client.end();
}
}