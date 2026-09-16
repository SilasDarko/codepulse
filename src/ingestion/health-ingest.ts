import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { healthEvents, incidents } from "@/src/db/schema";
import type { HealthEventInput } from "@/src/lib/validation";
import { ingestionEventsTotal } from "@/src/metrics/registry";

export interface IngestHealthEventResult {
  eventId: number;
  duplicate: boolean;
  /** the open incident this event affected, if any -- created, extended backward, or resolved */
  incidentId: number | null;
}

/**
 * Idempotent on (serviceId, externalId). Incident open/resolve decisions are
 * keyed on `observedAt`, never on the order events happen to arrive in, so
 * a health event that shows up late (out of order) still correctly
 * identifies the true first-unhealthy timestamp for an incident.
 */
export async function ingestHealthEvent(db: Database, input: HealthEventInput): Promise<IngestHealthEventResult> {
  return db.transaction(async (tx) => {
    const [existingEvent] = await tx
      .select({ id: healthEvents.id })
      .from(healthEvents)
      .where(and(eq(healthEvents.serviceId, input.serviceId), eq(healthEvents.externalId, input.externalId)));

    const [eventRow] = await tx
      .insert(healthEvents)
      .values({
        serviceId: input.serviceId,
        externalId: input.externalId,
        status: input.status,
        metricName: input.metricName ?? null,
        metricValue: input.metricValue ?? null,
        observedAt: new Date(input.observedAt),
        source: input.source,
      })
      .onConflictDoUpdate({
        target: [healthEvents.serviceId, healthEvents.externalId],
        set: { status: input.status, metricValue: input.metricValue ?? null },
      })
      .returning({ id: healthEvents.id });

    const duplicate = Boolean(existingEvent);
    if (!duplicate) ingestionEventsTotal.inc({ source: "health_webhook", entity: "health_event" });

    const observedAt = new Date(input.observedAt);
    const [openIncident] = await tx
      .select({ id: incidents.id, openedAt: incidents.openedAt })
      .from(incidents)
      .where(and(eq(incidents.serviceId, input.serviceId), eq(incidents.status, "open")))
      .orderBy(asc(incidents.openedAt))
      .limit(1);

    let incidentId: number | null = openIncident?.id ?? null;

    if (input.status !== "healthy") {
      if (!openIncident) {
        const [created] = await tx
          .insert(incidents)
          .values({ serviceId: input.serviceId, openedAt: observedAt, firstUnhealthyEventId: eventRow!.id, status: "open" })
          .returning({ id: incidents.id });
        incidentId = created!.id;
      } else if (observedAt < openIncident.openedAt) {
        // A health event that observed the outage earlier arrived after one that observed it later.
        await tx
          .update(incidents)
          .set({ openedAt: observedAt, firstUnhealthyEventId: eventRow!.id })
          .where(eq(incidents.id, openIncident.id));
      }
    } else if (openIncident) {
      // Only resolve if no later (by observedAt) event exists -- an out-of-order
      // "healthy" event that arrives between two "down" events must not close
      // an incident that, chronologically, is still ongoing.
      const [laterEvent] = await tx
        .select({ id: healthEvents.id })
        .from(healthEvents)
        .where(and(eq(healthEvents.serviceId, input.serviceId), gt(healthEvents.observedAt, observedAt)))
        .limit(1);

      if (!laterEvent) {
        await tx.update(incidents).set({ status: "resolved", resolvedAt: observedAt }).where(eq(incidents.id, openIncident.id));
      }
    }

    return { eventId: eventRow!.id, duplicate, incidentId };
  });
}
