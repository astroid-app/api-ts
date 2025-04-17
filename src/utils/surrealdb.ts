import Surreal from "surrealdb";
import * as dotenv from "dotenv";

dotenv.config();

// Define the database configuration interface
interface DbConfig {
  url: string;
  namespace: string;
  database: string;
}

// Define the default database configuration
export const DEFAULT_CONFIG: DbConfig = {
  url: process.env.DB_URL || "default_url",
  namespace: process.env.DB_NAMESPACE || "default_namespace",
  database: process.env.DB_DATABASE || "default_database",
};

export const TOKEN_CONFIG: DbConfig = {
  url: process.env.TOKEN_DB_URL || "default_url",
  namespace: process.env.TOKEN_DB_NAMESPACE || "token_namespace",
  database: process.env.TOKEN_DB_DATABASE || "token_database",
};

export interface DbAuth {
  username: string;
  password: string;
}

export const DEFAULT_AUTH: DbAuth = {
  username: process.env.DB_USERNAME || "default_username",
  password: process.env.DB_PASSWORD || "default_password",
};

export const TOKEN_AUTH: DbAuth = {
  username: process.env.TOKEN_DB_USERNAME || "token_username",
  password: process.env.TOKEN_DB_PASSWORD || "token_password",
};


// Define the function to get the database instance
export async function getDb(config: DbConfig = DEFAULT_CONFIG): Promise<Surreal> {
  const db = new Surreal();

  try {
    const auth = {
      namespace: config.namespace,
      database: config.database,
      auth: {      
        username: DEFAULT_AUTH.username,
        password: DEFAULT_AUTH.password,
      }
    };
    await db.connect(config.url, auth);
    await db.use({ namespace: config.namespace, database: config.database });
    return db;
  } catch (err) {
    console.error("Failed to connect to SurrealDB:", err instanceof Error ? err.message : String(err));
    await db.close();
    throw err;
  }
}

export async function getTokenDb(config: DbConfig = TOKEN_CONFIG): Promise<Surreal> {
  const db = new Surreal();

  try {
    const auth = {
      namespace: config.namespace,
      database: config.database,
      auth: {      
        username: TOKEN_AUTH.username,
        password: TOKEN_AUTH.password,
      }
    };
    console.log("Connecting to token database:", config.url, auth);
    await db.connect(config.url, auth);
    await db.use({ namespace: config.namespace, database: config.database });
    return db;
  } catch (err) {
    console.error("Failed to connect to SurrealDB:", err instanceof Error ? err.message : String(err));
    await db.close();
    throw err;
  }
}