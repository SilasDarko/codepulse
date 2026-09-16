import { and, eq } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { deployments, deploymentSteps } from "@/src/db/schema";
import type { DeploymentEventInput } from "@/src/lib/validation";
import { ingestionEventsTotal } from "@/src/metrics/registry";

export interface IngestDeploymentResult {
  deploymentId: number;
  /** true if a deployment with this (serviceId, externalId) already existed -- this call updated it in place. */
  duplicate: boolean;
}

/**
 * Idempotent on (serviceId, externalId): re-sending the same deployment
 * webhook (the "duplicate webhooks" failure case) updates the existing row
 * in place -- e.g. a status transition from in_progress to succeeded --
 * instead of creating a second deployment. Steps are replaced wholesale on
 * every call, which is simplest and safe because a deploy tool always sends
 * its full step list, not a diff.
 */
export async function ingestDeployment(db: Database, input: DeploymentEventInput): Promise<IngestDeploymentResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.serviceId, input.serviceId), eq(deployments.externalId, input.externalId)));

    const values = {
      serviceId: input.serviceId,
      externalId: input.externalId,
      fromSha: input.fromSha ?? null,
      toSha: input.toSha,
      status: input.status,
      startedAt: new Date(input.startedAt),
      completedAt: input.completedAt ? new Date(input.completedAt) : null,
    };

    const [row] = await tx
      .insert(deployments)
      .values(values)
      .onConflictDoUpdate({
        target: [deployments.serviceId, deployments.externalId],
        set: { status: values.status, completedAt: values.completedAt },
      })
      .returning({ id: deployments.id });

    await tx.delete(deploymentSteps).where(eq(deploymentSteps.deploymentId, row!.id));
    if (input.steps && input.steps.length > 0) {
      await tx.insert(deploymentSteps).values(
        input.steps.map((s) => ({
          deploymentId: row!.id,
          name: s.name,
          status: s.status,
          startedAt: s.startedAt ? new Date(s.startedAt) : null,
          completedAt: s.completedAt ? new Date(s.completedAt) : null,
        })),
      );
    }

    if (!existing) ingestionEventsTotal.inc({ source: "deployment_webhook", entity: "deployment" });
    return { deploymentId: row!.id, duplicate: Boolean(existing) };
  });
}
