-- Runs once when the Postgres container's data volume is first created.
-- Creates the separate database integration tests run against, so tests
-- never touch the same rows as `npm run dev` / `npm run seed`.
CREATE DATABASE codepulse_test;
