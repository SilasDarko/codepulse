import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { ciJobs, ciRuns, commitFiles, commits, pullRequests } from "@/src/db/schema";
import { ingestCommits, ingestCiRuns, ingestPullRequests, runGithubIngestion } from "@/src/ingestion/github-adapter";
import { getCheckpoint } from "@/src/ingestion/checkpoint";
import { createRepo } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";
import { makeFakeGithubClient } from "../helpers/fake-github-client";

beforeEach(truncateAll);
afterAll(closeDb);

describe("ingestCommits", () => {
  it("persists commits with their parent shas and changed files, then advances the checkpoint", async () => {
    const repo = await createRepo();
    const client = makeFakeGithubClient({
      commits: [
        {
          sha: "c1",
          parents: [],
          commit: { message: "init", author: { name: "Ada", email: "ada@example.com", date: "2026-01-01T00:00:00Z" } },
          files: [{ filename: "src/index.ts", status: "added" }],
        },
        {
          sha: "c2",
          parents: [{ sha: "c1" }],
          commit: { message: "fix", author: { name: "Ada", email: "ada@example.com", date: "2026-01-02T00:00:00Z" } },
          files: [{ filename: "src/index.ts", status: "modified" }],
        },
      ],
    });

    const result = await ingestCommits(client, db, repo);

    expect(result).toEqual({ ingested: 2, rateLimited: false });
    const rows = await db.select().from(commits).where(eq(commits.repoId, repo.id));
    expect(rows).toHaveLength(2);
    const c2 = rows.find((r) => r.sha === "c2")!;
    expect(c2.parentShas).toEqual(["c1"]);

    const files = await db.select().from(commitFiles).where(eq(commitFiles.commitId, c2.id));
    expect(files.map((f) => f.filePath)).toEqual(["src/index.ts"]);

    expect(await getCheckpoint(db, "github_commits", repo.id)).toBe("2026-01-02T00:00:00Z");
  });

  it("only fetches commits since the last checkpoint on a subsequent run", async () => {
    const repo = await createRepo();
    const firstBatch = [
      {
        sha: "c1",
        parents: [],
        commit: { message: "init", author: { name: "Ada", email: "a@x.com", date: "2026-01-01T00:00:00Z" } },
        files: [],
      },
    ];
    await ingestCommits(makeFakeGithubClient({ commits: firstBatch }), db, repo);

    let sinceSeen: string | undefined;
    const spyClient = makeFakeGithubClient({ commits: firstBatch });
    const originalListCommits = spyClient.rest.repos.listCommits.bind(spyClient.rest.repos);
    spyClient.rest.repos.listCommits = async (params) => {
      sinceSeen = params.since;
      return originalListCommits(params);
    };

    await ingestCommits(spyClient, db, repo);

    expect(sinceSeen).toBe("2026-01-01T00:00:00Z");
  });
});

describe("ingestPullRequests", () => {
  it("persists pull requests and is idempotent on (repoId, number)", async () => {
    const repo = await createRepo();
    const client = makeFakeGithubClient({
      pulls: [
        {
          number: 1,
          title: "Add feature",
          user: { login: "ada" },
          base: { sha: "base" },
          head: { sha: "head1" },
          additions: 10,
          deletions: 2,
          changed_files: 1,
          labels: [{ name: "feature" }],
          merged_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    await ingestPullRequests(client, db, repo);
    await ingestPullRequests(client, db, repo); // duplicate ingestion run

    const rows = await db.select().from(pullRequests).where(eq(pullRequests.repoId, repo.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Add feature");
  });
});

describe("ingestCiRuns", () => {
  it("links a CI run to its pull request and persists per-job conclusions", async () => {
    const repo = await createRepo();
    await ingestPullRequests(
      makeFakeGithubClient({
        pulls: [
          {
            number: 5,
            title: "x",
            user: null,
            base: { sha: "base" },
            head: { sha: "head5" },
            labels: [],
            merged_at: null,
          },
        ],
      }),
      db,
      repo,
    );

    const client = makeFakeGithubClient({
      workflowRuns: [
        {
          id: 999,
          name: "CI",
          head_sha: "head5",
          status: "completed",
          conclusion: "failure",
          run_started_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:10:00Z",
          pull_requests: [{ number: 5 }],
        },
      ],
      jobsByRunId: { 999: [{ name: "test", status: "completed", conclusion: "failure" }] },
    });

    await ingestCiRuns(client, db, repo);

    const [run] = await db.select().from(ciRuns).where(eq(ciRuns.externalId, "999"));
    expect(run!.conclusion).toBe("failure");
    const [pr] = await db.select().from(pullRequests).where(eq(pullRequests.number, 5));
    expect(run!.pullRequestId).toBe(pr!.id);

    const jobs = await db.select().from(ciJobs).where(eq(ciJobs.ciRunId, run!.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.conclusion).toBe("failure");
  });
});

describe("runGithubIngestion", () => {
  it("runs commits, then PRs, then CI runs in one call", async () => {
    const repo = await createRepo();
    const client = makeFakeGithubClient({
      commits: [
        {
          sha: "head5",
          parents: [],
          commit: { message: "m", author: { name: "a", email: "a@x.com", date: "2026-01-01T00:00:00Z" } },
          files: [],
        },
      ],
      pulls: [{ number: 5, title: "x", user: null, base: { sha: "b" }, head: { sha: "head5" }, labels: [], merged_at: null }],
      workflowRuns: [
        {
          id: 1,
          name: "CI",
          head_sha: "head5",
          status: "completed",
          conclusion: "success",
          run_started_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:05:00Z",
          pull_requests: [{ number: 5 }],
        },
      ],
      jobsByRunId: { 1: [] },
    });

    const result = await runGithubIngestion(client, db, repo);

    expect(result.commits.ingested).toBe(1);
    expect(result.pullRequests.ingested).toBe(1);
    expect(result.ciRuns.ingested).toBe(1);
  });
});
