import { getDb } from "./utils/pgsql";
import { Config } from "./types/Endpoint";
import { console } from "inspector";

type NestedKeyValue = { path: string[]; value: any };

function flattenObject(obj: any, prefix: string[] = []): NestedKeyValue[] {
  const entries: NestedKeyValue[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = [...prefix, key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      entries.push(...flattenObject(value, path));
    } else {
      entries.push({ path, value });
    }
  }

  return entries;
}

export async function updateEndpointConfig(
  endpointId: string,
  newConfig: Partial<Config>
): Promise<Config | undefined> {
  const client = await getDb();
  if (!client) {
    console.error("Database not initialized");
    return undefined;
  }

  try {
    const updates = flattenObject({ config: newConfig });
    console.debug("Updates to be made:", updates);
    const values: any[] = [endpointId];

    let baseExpr = "data";

    for (let i = updates.length - 1; i >= 0; i--) {
      const { path, value } = updates[i];
      const paramIndex = values.length + 1;

      let updateExpr = "";
      if (Array.isArray(value)) {
        updateExpr = `(
          COALESCE(${baseExpr} #> '{${path.join(
          ","
        )}}', '[]'::jsonb) || $${paramIndex}::jsonb
        )`;
        values.push(JSON.stringify(value));
      } else {
        updateExpr = `to_jsonb($${paramIndex}::text)`;
        values.push(value);
      }

      baseExpr = `jsonb_set(${baseExpr}, '{${path.join(
        ","
      )}}', ${updateExpr}, true)`;
    }

    const finalSQL = `UPDATE endpoints SET data = ${baseExpr} WHERE id = $1 RETURNING data`;

    const result = await client.query(finalSQL, values);

    if (result.rows.length === 0) {
      return undefined;
    }

    return result.rows[0].data.config as Config;
  } catch (err) {
    console.error("Error executing update for:", endpointId);
    throw err;
  } finally {
    await client.end();
  }
}

export async function removeArrayItemFromConfig(
  endpointId: string,
  removeConfig: Partial<Config>
): Promise<Config | undefined> {
  const client = await getDb();
  if (!client) {
    console.error("Database not initialized");
    return undefined;
  }

  try {
    const updates = flattenObject({ config: removeConfig });
    console.debug("Removes to be made:", updates);
    let baseExpr = "data";
    const values: any[] = [endpointId];
    console.debug("Base expression:", baseExpr);
    console.debug("Values:", values);

    // Build nested jsonb_set calls
    for (let i = updates.length - 1; i >= 0; i--) {
      const { path, value } = updates[i];
      const paramIndex = values.length + 1;

      if (!Array.isArray(value)) continue;

      values.push(JSON.stringify(value));
      console.debug("Value to remove:", value);

      // Construct SQL to filter array
      const pathStr = path.join(",");
      const fullPathStr = `{${pathStr}}`;

      const filterExpr = `
      CASE
        WHEN jsonb_typeof(${baseExpr} #> '${fullPathStr}') = 'array' THEN (
          SELECT jsonb_agg(elem)
          FROM jsonb_array_elements(${baseExpr} #> '${fullPathStr}') elem
          WHERE NOT elem = ANY (
            SELECT jsonb_array_elements($${paramIndex}::jsonb)
          )
        )
        ELSE ${baseExpr} #> '${fullPathStr}'
      END
    `; 

      baseExpr = `jsonb_set(${baseExpr}, '${fullPathStr}', COALESCE(${filterExpr}, '[]'::jsonb), true)`;
    }

    const sql = `UPDATE endpoints SET data = ${baseExpr} WHERE id = $1 RETURNING data`;
    const result = await client.query(sql, values);

    if (result.rows.length === 0) {
      return undefined;
    }

    return result.rows[0].data.config as Config;
  } catch (err) {
    console.error("Error removing items from array for:", endpointId);
    throw err;
  } finally {
    await client.end();
  }
}
