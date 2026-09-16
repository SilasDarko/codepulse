import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { commits } from "@/src/db/schema";
import { ingestCommits } from "@/src/ingestion/github-adapter";
import { getCheckpoint } from "@/src/ingestion/checkpoint";
import { createRepo } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";
import { makeFakeGithubClient } from "../helpers/fake-github-client";
import type { GithubApiClient } from "@/src/ingestion/github-types";

beforeEach(truncateAll);
afterAll(closeDb);

// Simulates a worker process that crashes partway through a page of commits
// (e.g. the machine is killed) and is then restarted. Nothing in
// ingestCommits wraps a whole page in a DB transaction -- individual commits
// are upserted as they're processed -- so the property under test is: a
// restarted run that re-fetches the same page must not create duplicates,
// and must still make forward progress on the commits it hadn't reached yet.
describe("worker restart mid-ingestion", () => {
  it("resumes from checkpoint after a crash without duplicating already-ingested commits", async () => {
    const repo = await createRepo();
    const commitFixtures = [
      { sha: "c1", parents: [], commit: { message: "m1", author: { name: "a", email: "a@x.com", date: "2026-01-01T00:00:00Z" } }, files: [] },
      { sha: "c2", parents: [{ sha: "c1" }], commit: { message: "m2", author: { name: "a", email: "a@x.com", date: "2026-01-02T00:00:00Z" } }, files: [] },
      { sha: "c3", parents: [{ sha: "c2" }], commit: { message: "m3", author: { name: "a", email: "a@x.com", date: "2026-01-03T00:00:00Z" } }, files: [] },
    ];

    const crashingClient = makeFakeGithubClient({ commits: commitFixtures });
    // getCommit is called once per commit to fetch its changed files; make it
    // throw on c3 to simulate the process dying after c1 and c2 are already
    // durably written but before the page finished processing.
    const realGetCommit = crashingClient.rest.repos.getCommit.bind(crashingClient.rest.repos);
    crashingClient.rest.repos.getCommit = async (params) => {
      if (params.ref === "c3") throw new Error("simulated crash");
      return realGetCommit(params);
    };

    await expect(ingestCommits(crashingClient, db, repo)).rejects.toThrow("simulated crash");

    // c1, c2, and c3's base row all made it in (the row is inserted before
    // its per-commit changed-files lookup runs), but c3's changed-files
    // lookup is what crashed -- and, critically, the checkpoint was never
    // advanced because the run as a whole never completed.
    const afterCrash = await db.select().from(commits).where(eq(commits.repoId, repo.id));
    expect(afterCrash.map((c) => c.sha).sort()).toEqual(["c1", "c2", "c3"]);
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBeNull();

    // "Restart": run ingestCommits again with a healthy client. Because the
    // checkpoint never advanced, it re-fetches the same page from the start --
    // c1, c2, and c3 must all upsert cleanly with no duplicate rows created.
    const healthyClient: GithubApiClient = makeFakeGithubClient({ commits: commitFixtures });
    const result = await ingestCommits(healthyClient, db, repo);

    expect(result).toEqual({ ingested: 3, rateLimited: false });
    const afterRestart = await db.select().from(commits).where(eq(commits.repoId, repo.id));
    expect(afterRestart).toHaveLength(3);
    expect(afterRestart.map((c) => c.sha).sort()).toEqual(["c1", "c2", "c3"]);
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBe("2026-01-03T00:00:00Z");
  });
});
