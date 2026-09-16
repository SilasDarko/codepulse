import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/db/client";
import { getCheckpoint, setCheckpoint } from "@/src/ingestion/checkpoint";
import { createRepo } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";

beforeEach(truncateAll);
afterAll(closeDb);

describe("ingestion checkpoints", () => {
  it("returns null when a source has never checkpointed for a repo", async () => {
    const repo = await createRepo();
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBeNull();
  });

  it("round-trips a cursor", async () => {
    const repo = await createRepo();
    await setCheckpoint(db, "github_commits", repo.id, "2026-01-01T00:00:00.000Z");
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("overwrites the cursor on repeated calls instead of erroring (worker restart resumes cleanly)", async () => {
    const repo = await createRepo();
    await setCheckpoint(db, "github_commits", repo.id, "2026-01-01T00:00:00.000Z");
    await setCheckpoint(db, "github_commits", repo.id, "2026-01-02T00:00:00.000Z");
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keeps separate cursors per source for the same repo", async () => {
    const repo = await createRepo();
    await setCheckpoint(db, "github_commits", repo.id, "commits-cursor");
    await setCheckpoint(db, "github_pull_requests", repo.id, "prs-cursor");
    expect(await getCheckpoint(db, "github_commits", repo.id)).toBe("commits-cursor");
    expect(await getCheckpoint(db, "github_pull_requests", repo.id)).toBe("prs-cursor");
  });
});
