import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';
import log from "./logger";
import { exit } from 'process';

dotenv.config();

export const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DATABASE,
    password: process.env.POSTGRES_PASSWORD,
    port: Number(process.env.POSTGRES_PORT),
    max: 10, // Weitere Reduzierung für Stabilität
    min: 1, // Mindestens 1 Verbindung
    idleTimeoutMillis: 60000, // 60 Sekunden - länger für weniger Reconnects
    connectionTimeoutMillis: 30000, // 30 Sekunden - viel mehr Zeit für langsame Verbindungen
    query_timeout: 30000, // Timeout für einzelne Queries
    statement_timeout: 30000, // Statement Timeout
});

// Listen for error events and attempt to reconnect if connection is lost
pool.on('error', async (err) => {
    log("ERROR", "Unexpected error on idle client:", err instanceof Error ? err.message : String(err));
    // Nicht den ganzen Pool beenden - das verursacht mehr Probleme
});

// Event listener für Verbindungsaufbau
pool.on('connect', (client) => {
    log("INFO", "New client connected to database");
});

// Event listener für Verbindungsabbau
pool.on('remove', (client) => {
    log("INFO", "Client removed from pool");
});

export async function getPoolClient(): Promise<PoolClient> {
    let retries = 5; // Mehr Versuche
    while (retries > 0) {
        try {
            log("INFO", `Attempting to connect to database... (${retries} retries left)`);
            const client = await pool.connect();
            
            // Einfacherer Test - nur prüfen ob Verbindung steht
            await client.query('SELECT 1 as test');
            log("INFO", `Database connection successful (${process.env.POSTGRES_HOST})`);
            return client;
        } catch (err) {
            retries--;
            const errorMsg = err instanceof Error ? err.message : String(err);
            log("ERROR", `Failed to get a database connection (${retries} retries left):`, errorMsg);
            
            if (retries === 0) {
                log("ERROR", "All connection attempts failed, throwing error");
                throw err;
            }
            
            // Längere Wartezeiten: 2s, 4s, 8s, 16s
            const delay = Math.pow(2, 6 - retries) * 1000;
            log("INFO", `Waiting ${delay}ms before retry...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    throw new Error("Failed to connect after all retries");
}

// Legacy: getDb gibt einen PoolClient zurück, damit bestehende Aufrufe nicht sofort brechen
export async function getDb(): Promise<PoolClient> {
    return await getPoolClient();
}

// Test-Funktion für Datenbankverbindung
export async function testDatabaseConnection(): Promise<boolean> {
    try {
        log("INFO", "Testing database connection...");
        const client = await getPoolClient();
        try {
            await client.query('SELECT NOW() as current_time');
            log("INFO", "Database connection test successful");
            return true;
        } finally {
            client.release();
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log("ERROR", "Database connection test failed:", errorMsg);
        exit(1);
    }
}

// Pool-Status anzeigen
export function getPoolStatus() {
    const status = {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
    };
    log("INFO", "Pool status:", JSON.stringify(status));
    return status;
}