import { Client } from 'pg';
import * as dotenv from 'dotenv';

export async function getDb(): Promise<Client> {
    // Create a new PostgreSQL client instance
    dotenv.config();

    const client = new Client({
        user: process.env.POSTGRES_USER,
        host: process.env.POSTGRES_HOST,
        database: process.env.POSTGRES_DATABASE,
        password: process.env.POSTGRES_PASSWORD,
        port: Number(process.env.POSTGRES_PORT),
    });

    await client.connect();
    return client;
}