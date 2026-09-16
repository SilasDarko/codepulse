import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { deploymentSteps, deployments } from "@/src/db/schema";
import { ingestDeployment } from "@/src/ingestion/deployment-ingest";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";

beforeEach(truncateAll);
afterAll(closeDb);

describe("ingestDeployment", () => {
  it("creates a new deployment with its steps", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    const result = await ingestDeployment(db, {
      serviceId: service.id,
      externalId: "deploy-1",
      fromSha: "a",
      toSha: "b",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
      steps: [{ name: "build", status: "succeeded" }],
    });

    expect(result.duplicate).toBe(false);
    const [row] = await db.select().from(deployments).where(eq(deployments.id, result.deploymentId));
    expect(row!.status).toBe("succeeded");
    const steps = await db.select().from(deploymentSteps).where(eq(deploymentSteps.deploymentId, result.deploymentId));
    expect(steps).toHaveLength(1);
  });

  it("is idempotent: re-sending the same externalId updates the existing row instead of creating a second one", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);
    const input = {
      serviceId: service.id,
      externalId: "deploy-1",
      toSha: "b",
      status: "in_progress" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    const first = await ingestDeployment(db, input);
    const second = await ingestDeployment(db, { ...input, status: "succeeded", completedAt: "2026-01-01T00:05:00.000Z" });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.deploymentId).toBe(first.deploymentId);

    const rows = await db.select().from(deployments).where(eq(deployments.serviceId, service.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
  });

  it("replaces steps wholesale on re-ingestion rather than accumulating duplicates", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);
    const base = {
      serviceId: service.id,
      externalId: "deploy-1",
      toSha: "b",
      status: "succeeded" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
    };

    const first = await ingestDeployment(db, { ...base, steps: [{ name: "build", status: "succeeded" }] });
    await ingestDeployment(db, {
      ...base,
      steps: [
        { name: "build", status: "succeeded" },
        { name: "deploy", status: "succeeded" },
      ],
    });

    const steps = await db.select().from(deploymentSteps).where(eq(deploymentSteps.deploymentId, first.deploymentId));
    expect(steps).toHaveLength(2);
  });
});
