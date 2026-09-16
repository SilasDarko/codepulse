import "dotenv/config";

// Integration/failure-path tests import src/db/client.ts, which reads
// DATABASE_URL. Point that at the dedicated test database so `npm test`
// never touches the rows you're looking at in `npm run dev`.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
