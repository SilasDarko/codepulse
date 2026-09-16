import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { commits, commitFiles, ciJobs, ciRuns, deployments, incidents, pullRequests, services } from "@/src/db/schema";
import type { CandidatePullRequest, CiConclusion, CommitNode, ScoringInput } from "./types";

// How far back from the incident's first-unhealthy timestamp we look for
// deployments and commits. Past this, a deployment is assumed unrelated --
// see DESIGN_DECISIONS.md for why 24h and what widening it costs.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Turns one incident's row plus everything ingested around it into the
 * plain-data ScoringInput the pure correlation engine (rank.ts) consumes.
 * This is the only place in the correlation package that talks to Postgres.
 *
 * Known simplification: a commit is considered "part of" a pull request only
 * when it is that PR's head commit (commit.sha === pr.headSha). Intermediate
 * commits on a PR branch are scored as plain commits with no PR-level CI/size
 * signal. This keeps the load query simple; a fuller version would resolve
 * PR membership via base..head ancestry the same way deployment ranges are
 * resolved in ancestry.ts.
 */
export async function loadScoringInputForIncident(db: Database, incidentId: number): Promise<ScoringInput | null> {
  const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!incident) return null;

  const [service] = await db.select().from(services).where(eq(services.id, incident.serviceId));
  if (!service) return null;

  const firstUnhealthyAt = incident.openedAt;
  const windowStart = new Date(firstUnhealthyAt.getTime() - LOOKBACK_MS);

  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, service.id),
        lte(deployments.startedAt, firstUnhealthyAt),
        gte(deployments.startedAt, windowStart),
      ),
    )
    .orderBy(asc(deployments.startedAt));

  const commitRows = await db
    .select()
    .from(commits)
    .where(and(eq(commits.repoId, service.repoId), lte(commits.committedAt, firstUnhealthyAt), gte(commits.committedAt, windowStart)));

  const commitIds = commitRows.map((c) => c.id);
  const fileRows = commitIds.length
    ? await db.select().from(commitFiles).where(inArray(commitFiles.commitId, commitIds))
    : [];
  const filesByCommitId = new Map<number, string[]>();
  for (const f of fileRows) {
    const list = filesByCommitId.get(f.commitId) ?? [];
    list.push(f.filePath);
    filesByCommitId.set(f.commitId, list);
  }

  const prRows = await db.select().from(pullRequests).where(eq(pullRequests.repoId, service.repoId));
  const prByHeadSha = new Map(prRows.filter((p) => p.headSha).map((p) => [p.headSha as string, p]));

  const prIds = prRows.map((p) => p.id);
  const ciRunRows = prIds.length ? await db.select().from(ciRuns).where(inArray(ciRuns.pullRequestId, prIds)) : [];
  const ciRunIds = ciRunRows.map((r) => r.id);
  const ciJobRows = ciRunIds.length ? await db.select().from(ciJobs).where(inArray(ciJobs.ciRunId, ciRunIds)) : [];
  const jobsByRunId = new Map<number, { conclusion: CiConclusion }[]>();
  for (const j of ciJobRows) {
    const list = jobsByRunId.get(j.ciRunId) ?? [];
    list.push({ conclusion: j.conclusion });
    jobsByRunId.set(j.ciRunId, list);
  }
  const ciRunsByPrId = new Map<number, typeof ciRunRows>();
  for (const r of ciRunRows) {
    if (r.pullRequestId === null) continue;
    const list = ciRunsByPrId.get(r.pullRequestId) ?? [];
    list.push(r);
    ciRunsByPrId.set(r.pullRequestId, list);
  }

  const commitsBySha = new Map<string, CommitNode>();
  for (const c of commitRows) {
    const pr = prByHeadSha.get(c.sha);
    let pullRequest: CandidatePullRequest | null = null;
    if (pr) {
      const runs = ciRunsByPrId.get(pr.id) ?? [];
      pullRequest = {
        number: pr.number,
        title: pr.title,
        additions: pr.additions,
        deletions: pr.deletions,
        labels: pr.labels,
        ciRuns: runs.map((r) => ({
          conclusion: r.conclusion,
          jobs: jobsByRunId.get(r.id) ?? [],
        })),
      };
    }

    commitsBySha.set(c.sha, {
      sha: c.sha,
      parentShas: c.parentShas,
      committedAt: c.committedAt,
      changedFiles: filesByCommitId.get(c.id) ?? [],
      pullRequest,
    });
  }

  return {
    firstUnhealthyAt,
    servicePathPatterns: service.pathPatterns,
    deployments: deploymentRows.map((d) => ({
      id: d.id,
      fromSha: d.fromSha,
      toSha: d.toSha,
      startedAt: d.startedAt,
      completedAt: d.completedAt,
    })),
    commitsBySha,
  };
}
