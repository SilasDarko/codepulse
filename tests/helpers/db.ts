import { sql } from "drizzle-orm";
import { db, pool } from "@/src/db/client";

/** Wipes every domain table between tests. Test-only -- never imported by app code. */
export async function truncateAll(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE
    benchmark_ground_truth, correlation_results, ingestion_checkpoints,
    incidents, health_events, deployment_steps, deployments, services,
    ci_jobs, ci_runs, pull_requests, commit_files, commits, repositories
    RESTART IDENTITY CASCADE`);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
