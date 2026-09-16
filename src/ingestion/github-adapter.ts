import { eq, and } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { commits, commitFiles, pullRequests, ciRuns, ciJobs } from "@/src/db/schema";
import { getCheckpoint, setCheckpoint } from "./checkpoint";
import { ingestionEventsTotal, ingestionErrorsTotal, githubRateLimitRemaining } from "@/src/metrics/registry";
import { isRateLimitError, type GithubApiClient, type GithubWorkflowRunDTO } from "./github-types";
import type { CiConclusion } from "@/src/correlation/types";

const PAGE_SIZE = 100;
// Ceiling on pages per call so one adapter invocation can't run forever
// against a repo with a huge history; the checkpoint means the next call
// just continues where this one left off.
const MAX_PAGES_PER_RUN = 20;

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

export interface IngestSummary {
  ingested: number;
  rateLimited: boolean;
}

function recordRateLimit(headers: Record<string, string | undefined>): void {
  const remaining = headers["x-ratelimit-remaining"];
  if (remaining !== undefined) githubRateLimitRemaining.set(Number(remaining));
}

function mapConclusion(raw: string | null): CiConclusion {
  if (raw === null) return "pending";
  if (raw === "success" || raw === "failure" || raw === "cancelled" || raw === "skipped") return raw;
  // timed_out, action_required, stale, neutral, etc. -- treat as failure-like
  // rather than inventing more enum values the scorer would have to special-case.
  return "failure";
}

/**
 * Pulls new commits since the last checkpoint, upserts them (and their
 * changed-file lists) idempotently, and advances the checkpoint. Stops
 * early -- without throwing -- if GitHub rate-limits the request; the
 * checkpoint only advances past commits actually persisted, so a rate
 * limited run is always safe to simply call again later.
 */
export async function ingestCommits(client: GithubApiClient, db: Database, repo: RepoRef): Promise<IngestSummary> {
  const since = await getCheckpoint(db, "github_commits", repo.id);
  let ingested = 0;
  let latestSeen = since;

  try {
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      const { data, headers } = await client.rest.repos.listCommits({
        owner: repo.owner,
        repo: repo.name,
        per_page: PAGE_SIZE,
        page,
        since: since ?? undefined,
      });
      recordRateLimit(headers);
      if (data.length === 0) break;

      for (const dto of data) {
        const committedAt = dto.commit.author?.date ?? new Date().toISOString();

        const [row] = await db
          .insert(commits)
          .values({
            repoId: repo.id,
            sha: dto.sha,
            parentShas: dto.parents.map((p) => p.sha),
            authorName: dto.commit.author?.name ?? null,
            authorEmail: dto.commit.author?.email ?? null,
            message: dto.commit.message,
            committedAt: new Date(committedAt),
          })
          .onConflictDoUpdate({
            target: [commits.repoId, commits.sha],
            set: {
              parentShas: dto.parents.map((p) => p.sha),
              message: dto.commit.message,
            },
          })
          .returning({ id: commits.id });

        const { data: detail } = await client.rest.repos.getCommit({ owner: repo.owner, repo: repo.name, ref: dto.sha });
        await db.delete(commitFiles).where(eq(commitFiles.commitId, row!.id));
        if (detail.files && detail.files.length > 0) {
          await db.insert(commitFiles).values(
            detail.files.map((f) => ({ commitId: row!.id, filePath: f.filename, status: f.status })),
          );
        }

        ingested++;
        ingestionEventsTotal.inc({ source: "github", entity: "commit" });
        if (!latestSeen || committedAt > latestSeen) latestSeen = committedAt;
      }

      if (data.length < PAGE_SIZE) break;
    }
  } catch (err) {
    if (isRateLimitError(err)) {
      if (latestSeen) await setCheckpoint(db, "github_commits", repo.id, latestSeen);
      return { ingested, rateLimited: true };
    }
    ingestionErrorsTotal.inc({ source: "github_commits", reason: "unexpected_error" });
    throw err;
  }

  if (latestSeen) await setCheckpoint(db, "github_commits", repo.id, latestSeen);
  return { ingested, rateLimited: false };
}

export async function ingestPullRequests(client: GithubApiClient, db: Database, repo: RepoRef): Promise<IngestSummary> {
  let ingested = 0;

  try {
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      const { data, headers } = await client.rest.pulls.list({
        owner: repo.owner,
        repo: repo.name,
        state: "all",
        per_page: PAGE_SIZE,
        page,
        sort: "updated",
        direction: "desc",
      });
      recordRateLimit(headers);
      if (data.length === 0) break;

      for (const dto of data) {
        await db
          .insert(pullRequests)
          .values({
            repoId: repo.id,
            number: dto.number,
            title: dto.title,
            authorLogin: dto.user?.login ?? null,
            baseSha: dto.base.sha,
            headSha: dto.head.sha,
            additions: dto.additions ?? 0,
            deletions: dto.deletions ?? 0,
            changedFilesCount: dto.changed_files ?? 0,
            labels: dto.labels.map((l) => l.name),
            mergedAt: dto.merged_at ? new Date(dto.merged_at) : null,
          })
          .onConflictDoUpdate({
            target: [pullRequests.repoId, pullRequests.number],
            set: {
              title: dto.title,
              additions: dto.additions ?? 0,
              deletions: dto.deletions ?? 0,
              changedFilesCount: dto.changed_files ?? 0,
              labels: dto.labels.map((l) => l.name),
              mergedAt: dto.merged_at ? new Date(dto.merged_at) : null,
            },
          });

        ingested++;
        ingestionEventsTotal.inc({ source: "github", entity: "pull_request" });
      }

      if (data.length < PAGE_SIZE) break;
    }
  } catch (err) {
    if (isRateLimitError(err)) return { ingested, rateLimited: true };
    ingestionErrorsTotal.inc({ source: "github_pull_requests", reason: "unexpected_error" });
    throw err;
  }

  return { ingested, rateLimited: false };
}

async function findPullRequestId(db: Database, repoId: number, run: GithubWorkflowRunDTO): Promise<number | null> {
  const prNumber = run.pull_requests?.[0]?.number;
  if (!prNumber) return null;
  const [match] = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, prNumber)));
  return match?.id ?? null;
}

export async function ingestCiRuns(client: GithubApiClient, db: Database, repo: RepoRef): Promise<IngestSummary> {
  let ingested = 0;

  try {
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      const { data, headers } = await client.rest.actions.listWorkflowRunsForRepo({
        owner: repo.owner,
        repo: repo.name,
        per_page: PAGE_SIZE,
        page,
      });
      recordRateLimit(headers);
      const runs = data.workflow_runs;
      if (runs.length === 0) break;

      for (const run of runs) {
        const pullRequestId = await findPullRequestId(db, repo.id, run);

        const [row] = await db
          .insert(ciRuns)
          .values({
            repoId: repo.id,
            pullRequestId,
            externalId: String(run.id),
            commitSha: run.head_sha,
            workflowName: run.name ?? "",
            status: run.status,
            conclusion: mapConclusion(run.conclusion),
            startedAt: run.run_started_at ? new Date(run.run_started_at) : null,
            completedAt: run.status === "completed" ? new Date(run.updated_at) : null,
          })
          .onConflictDoUpdate({
            target: [ciRuns.repoId, ciRuns.externalId],
            set: {
              status: run.status,
              conclusion: mapConclusion(run.conclusion),
              completedAt: run.status === "completed" ? new Date(run.updated_at) : null,
            },
          })
          .returning({ id: ciRuns.id });

        const { data: jobData } = await client.rest.actions.listJobsForWorkflowRun({
          owner: repo.owner,
          repo: repo.name,
          run_id: run.id,
        });
        await db.delete(ciJobs).where(eq(ciJobs.ciRunId, row!.id));
        if (jobData.jobs.length > 0) {
          await db.insert(ciJobs).values(
            jobData.jobs.map((j) => ({
              ciRunId: row!.id,
              name: j.name,
              status: j.status,
              conclusion: mapConclusion(j.conclusion),
            })),
          );
        }

        ingested++;
        ingestionEventsTotal.inc({ source: "github", entity: "ci_run" });
      }

      if (runs.length < PAGE_SIZE) break;
    }
  } catch (err) {
    if (isRateLimitError(err)) return { ingested, rateLimited: true };
    ingestionErrorsTotal.inc({ source: "github_ci_runs", reason: "unexpected_error" });
    throw err;
  }

  return { ingested, rateLimited: false };
}

export interface GithubIngestionResult {
  commits: IngestSummary;
  pullRequests: IngestSummary;
  ciRuns: IngestSummary;
}

/** Runs all three GitHub ingestion steps for one repo, in the order the correlation engine needs data available. */
export async function runGithubIngestion(client: GithubApiClient, db: Database, repo: RepoRef): Promise<GithubIngestionResult> {
  const commitsResult = await ingestCommits(client, db, repo);
  const pullRequestsResult = await ingestPullRequests(client, db, repo);
  const ciRunsResult = await ingestCiRuns(client, db, repo);
  return { commits: commitsResult, pullRequests: pullRequestsResult, ciRuns: ciRunsResult };
}
