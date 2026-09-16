import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { commits, correlationResults, deployments, incidents } from "@/src/db/schema";
import { runPollCycle } from "@/src/worker/poll-cycle";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";
import type { GithubApiClient } from "@/src/ingestion/github-types";

beforeEach(truncateAll);
afterAll(closeDb);

function throwingClient(): GithubApiClient {
  return {
    rest: {
      repos: {
        listCommits: async () => {
          throw new Error("GitHub is down");
        },
        getCommit: async () => {
          throw new Error("GitHub is down");
        },
      },
      pulls: { list: async () => { throw new Error("GitHub is down"); } },
      actions: {
        listWorkflowRunsForRepo: async () => { throw new Error("GitHub is down"); },
        listJobsForWorkflowRun: async () => { throw new Error("GitHub is down"); },
      },
    },
  };
}

describe("worker poll-cycle failure isolation", () => {
  it("still recomputes correlation for open incidents when GitHub ingestion throws", async () => {
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
    await db.insert(deployments).values({
      serviceId: service.id,
      externalId: "d1",
      fromSha: null,
      toSha: "c1",
      status: "succeeded",
      startedAt: new Date("2026-01-01T11:55:00.000Z"),
      completedAt: new Date("2026-01-01T11:56:00.000Z"),
    });

    await expect(
      runPollCycle(db, { client: throwingClient(), repo: { id: repo.id, owner: repo.owner, name: repo.name } }),
    ).resolves.toBeUndefined();

    const results = await db.select().from(correlationResults).where(eq(correlationResults.incidentId, incident!.id));
    expect(results.length).toBeGreaterThan(0);
  });

  it("does nothing but also does not throw when there is no GitHub target configured", async () => {
    await expect(runPollCycle(db, null)).resolves.toBeUndefined();
  });
});
