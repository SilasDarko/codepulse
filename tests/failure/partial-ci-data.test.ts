import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/db/client";
import { ciRuns, commits, deployments, incidents, pullRequests } from "@/src/db/schema";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";

beforeEach(truncateAll);
afterAll(closeDb);

describe("partial CI data", () => {
  it("scores a commit whose CI run is still in flight (no conclusion, no jobs yet) instead of crashing", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id, { pathPatterns: ["src/**"] });

    const firstUnhealthyAt = new Date("2026-01-01T12:00:00.000Z");
    const [incident] = await db
      .insert(incidents)
      .values({ serviceId: service.id, openedAt: firstUnhealthyAt, status: "open" })
      .returning();

    await db.insert(commits).values({
      repoId: repo.id,
      sha: "c1",
      parentShas: [],
      message: "m",
      committedAt: new Date("2026-01-01T11:55:00.000Z"),
    });

    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId: repo.id, number: 1, title: "x", headSha: "c1", baseSha: "base" })
      .returning();

    // Still running: status "in_progress", conclusion null, no job rows yet.
    await db.insert(ciRuns).values({
      repoId: repo.id,
      pullRequestId: pr!.id,
      externalId: "run-1",
      commitSha: "c1",
      status: "in_progress",
      conclusion: null,
      startedAt: new Date("2026-01-01T11:54:00.000Z"),
      completedAt: null,
    });

    await db.insert(deployments).values({
      serviceId: service.id,
      externalId: "d1",
      fromSha: null,
      toSha: "c1",
      status: "succeeded",
      startedAt: new Date("2026-01-01T11:55:00.000Z"),
      completedAt: new Date("2026-01-01T11:56:00.000Z"),
    });

    const ranked = await computeCorrelationForIncident(db, incident!.id);

    const commitCandidate = ranked.find((r) => r.candidateType === "commit" && r.candidateRef === "c1");
    expect(commitCandidate).toBeDefined();
    expect(commitCandidate!.breakdown.partialData).toBe(true);
    expect(commitCandidate!.score).toBeGreaterThanOrEqual(0);
  });
});
