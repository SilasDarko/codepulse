// Applies pending SQL migrations from src/db/migrations to a database.
// Usage:
//   npm run db:migrate            -> applies to DATABASE_URL
//   npm run db:migrate -- --test  -> applies to DATABASE_URL_TEST
import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const useTestDb = process.argv.includes("--test");
const connectionString = useTestDb ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;

if (!connectionString) {
  const varName = useTestDb ? "DATABASE_URL_TEST" : "DATABASE_URL";
  throw new Error(`${varName} is not set. Copy .env.example to .env and fill it in.`);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);

console.log(`Applying migrations to ${useTestDb ? "test" : "app"} database...`);
await migrate(db, { migrationsFolder: "./src/db/migrations" });
console.log("Done.");

await pool.end();
