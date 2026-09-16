import { eq, and } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { ingestionCheckpoints } from "@/src/db/schema";

// Ingestion sources -- one checkpoint row per (source, repo). Keeping this
// as a plain string union (not a DB enum) because it's an application-level
// concept, not a domain fact worth enforcing at the schema level.
export type IngestionSource = "github_commits" | "github_pull_requests" | "github_ci_runs";

/**
 * Returns the cursor left by the last successful run of this source for
 * this repo, or null if it has never run (or never got past its first page).
 * This is what makes ingestion resumable across worker restarts: on restart
 * the worker just calls this again instead of tracking anything in memory.
 */
export async function getCheckpoint(db: Database, source: IngestionSource, repoId: number): Promise<string | null> {
  const [row] = await db
    .select({ cursor: ingestionCheckpoints.cursor })
    .from(ingestionCheckpoints)
    .where(and(eq(ingestionCheckpoints.source, source), eq(ingestionCheckpoints.repoId, repoId)));
  return row?.cursor ?? null;
}

export async function setCheckpoint(
  db: Database,
  source: IngestionSource,
  repoId: number,
  cursor: string,
): Promise<void> {
  await db
    .insert(ingestionCheckpoints)
    .values({ source, repoId, cursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [ingestionCheckpoints.source, ingestionCheckpoints.repoId],
      set: { cursor, updatedAt: new Date() },
    });
}
