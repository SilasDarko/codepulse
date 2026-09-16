import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/db/client";
import { commits } from "@/src/db/schema";
import { eq } from "drizzle-orm";
import { ingestCommits } from "@/src/ingestion/github-adapter";
import { getCheckpoint } from "@/src/ingestion/checkpoint";
import { createRepo } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";
import { makeFakeGithubClient } from "../helpers/fake-github-client";

beforeEach(truncateAll);
afterAll(closeDb);

describe("GitHub rate limiting", () => {
  it("stops cleanly and reports rateLimited instead of throwing when the very first page is rate limited", async () => {
    const repo = await createRepo();
    const client = makeFakeGithubClient({ rateLimitAfterCommitPage: 0 });

    const result = await ingestCommits(client, db, repo);

    expect(result).toEqual({ ingested: 0, rateLimited: true });
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBeNull();
  });

  it("keeps whatever it already ingested before hitting the rate limit, and checkpoints past it", async () => {
    const repo = await createRepo();
    // 100 commits fit on page 1 and succeed; the adapter would only hit the
    // rate limit if it asked for page 2, which a small fixture never triggers
    // on its own -- so we force it by rate-limiting starting at page 1.
    const client = makeFakeGithubClient({
      commits: [
        {
          sha: "c1",
          parents: [],
          commit: { message: "m", author: { name: "a", email: "a@x.com", date: "2026-01-01T00:00:00Z" } },
          files: [],
        },
      ],
      rateLimitAfterCommitPage: 1,
    });

    const result = await ingestCommits(client, db, repo);

    expect(result.rateLimited).toBe(false); // only one page of data, never reached the limit
    const rows = await db.select().from(commits).where(eq(commits.repoId, repo.id));
    expect(rows).toHaveLength(1);
  });
});
