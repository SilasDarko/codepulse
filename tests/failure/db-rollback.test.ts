import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { deployments } from "@/src/db/schema";
import { ingestDeployment } from "@/src/ingestion/deployment-ingest";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";
import type { DeploymentEventInput } from "@/src/lib/validation";

beforeEach(truncateAll);
afterAll(closeDb);

describe("DB rollback on partial failure", () => {
  it("leaves no deployment row behind when a later statement in the same transaction fails", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    // ingestDeployment inserts the deployment row, then its steps, inside one
    // db.transaction(). A step with a null `name` violates the NOT NULL
    // constraint on deployment_steps.name -- this forces that second insert
    // to fail and proves the first insert (the deployment itself) is rolled
    // back with it, not left as an orphaned row.
    const badInput = {
      serviceId: service.id,
      externalId: "deploy-rollback",
      toSha: "b",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      steps: [{ name: null as unknown as string, status: "succeeded" }],
    } satisfies DeploymentEventInput;

    await expect(ingestDeployment(db, badInput)).rejects.toThrow();

    const rows = await db.select().from(deployments).where(eq(deployments.externalId, "deploy-rollback"));
    expect(rows).toHaveLength(0);
  });
});
