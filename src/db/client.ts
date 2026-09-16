import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// A single pool shared by the whole process. Next.js route handlers, the
// worker, and scripts all import this same module, so in dev/prod there is
// exactly one pool per process -- not one connection per request.
export const pool = new Pool({ connectionString, max: 30 });

export const db = drizzle(pool, { schema });

export type Database = typeof db;
