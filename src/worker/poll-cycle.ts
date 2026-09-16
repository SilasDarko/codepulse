import { and, eq } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { incidents, repositories } from "@/src/db/schema";
import { runGithubIngestion, type RepoRef } from "@/src/ingestion/github-adapter";
import type { GithubApiClient } from "@/src/ingestion/github-types";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { workerFailuresTotal } from "@/src/metrics/registry";

export interface GithubIngestionTarget {
  client: GithubApiClient;
  repo: RepoRef;
}

/**
 * One iteration of the worker's job: (1) pull anything new from GitHub for
 * the tracked repo, then (2) recompute ranked candidates for every open
 * incident. The two stages are independently try/caught -- a GitHub outage
 * must not stop correlation from running against data that's already
 * ingested, and a correlation bug must not stop ingestion from making
 * progress next cycle. Each failure increments workerFailuresTotal with a
 * `stage` label instead of throwing, so a bad cycle shows up in metrics
 * (and the next `setInterval` tick) rather than crashing the process.
 */
export async function runPollCycle(db: Database, github: GithubIngestionTarget | null): Promise<void> {
  if (github) {
    try {
      const result = await runGithubIngestion(github.client, db, github.repo);
      console.log(`[worker] github ingestion: ${JSON.stringify(result)}`);
    } catch (err) {
      workerFailuresTotal.inc({ stage: "github_ingestion" });
      console.error("[worker] github ingestion failed:", err);
    }
  }

  try {
    const openIncidents = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.status, "open"));
    for (const incident of openIncidents) {
      await computeCorrelationForIncident(db, incident.id);
    }
  } catch (err) {
    workerFailuresTotal.inc({ stage: "correlation" });
    console.error("[worker] correlation failed:", err);
  }
}

/** Finds or creates the repositories row for GITHUB_REPO ("owner/name"), so ingestion has a repo_id to write against. */
export async function resolveTrackedRepo(db: Database, ownerSlashName: string): Promise<RepoRef> {
  const [owner, name] = ownerSlashName.split("/");
  if (!owner || !name) throw new Error(`GITHUB_REPO must be "owner/name", got "${ownerSlashName}"`);

  const [existing] = await db.select().from(repositories).where(and(eq(repositories.owner, owner), eq(repositories.name, name)));
  if (existing) return existing;

  const [created] = await db.insert(repositories).values({ owner, name }).returning();
  return created!;
}
