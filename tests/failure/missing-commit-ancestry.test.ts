import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/src/db/client";
import { commits, deployments, incidents } from "@/src/db/schema";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";

beforeEach(truncateAll);
afterAll(closeDb);

describe("missing commit ancestry", () => {
  it("still produces a ranked (if lower-confidence) result instead of crashing when a deployment's base commit was never ingested", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id, { pathPatterns: ["src/**"] });

    const firstUnhealthyAt = new Date("2026-01-01T12:00:00.000Z");
    const [incident] = await db
      .insert(incidents)
      .values({ serviceId: service.id, openedAt: firstUnhealthyAt, status: "open" })
      .returning();

    // c3's parent "c2" is deliberately never inserted, so the ancestry walk
    // from toSha down to the deployment's fromSha boundary hits a dead end --
    // a shallow-cloned or partially-ingested repo history. (fromSha itself,
    // "c0", never needs to be ingested -- it represents the commit that was
    // already live before this deployment.)
    await db.insert(commits).values({
      repoId: repo.id,
      sha: "c3",
      parentShas: ["c2"],
      message: "m",
      committedAt: new Date("2026-01-01T11:55:00.000Z"),
    });

    await db.insert(deployments).values({
      serviceId: service.id,
      externalId: "d1",
      fromSha: "c0",
      toSha: "c3",
      status: "succeeded",
      startedAt: new Date("2026-01-01T11:55:00.000Z"),
      completedAt: new Date("2026-01-01T11:56:00.000Z"),
    });

    const ranked = await computeCorrelationForIncident(db, incident!.id);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.candidateRef).toBe("c3");
    expect(ranked[0]!.breakdown.partialData).toBe(true);
    expect(ranked[0]!.breakdown.fileOverlap).toBe(0);
  });
});
