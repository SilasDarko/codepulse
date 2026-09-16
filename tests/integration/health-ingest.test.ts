import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { healthEvents, incidents } from "@/src/db/schema";
import { ingestHealthEvent } from "@/src/ingestion/health-ingest";
import { createRepo, createService } from "../helpers/fixtures";
import { closeDb, truncateAll } from "../helpers/db";

beforeEach(truncateAll);
afterAll(closeDb);

describe("ingestHealthEvent", () => {
  it("opens an incident on the first unhealthy event for a service", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    const result = await ingestHealthEvent(db, {
      serviceId: service.id,
      externalId: "ev-1",
      status: "down",
      observedAt: "2026-01-01T12:00:00.000Z",
      source: "synthetic",
    });

    expect(result.incidentId).not.toBeNull();
    const [incident] = await db.select().from(incidents).where(eq(incidents.id, result.incidentId!));
    expect(incident!.status).toBe("open");
    expect(incident!.openedAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("does not open a second incident while one is already open for the service", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-1", status: "down", observedAt: "2026-01-01T12:00:00.000Z", source: "synthetic" });
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-2", status: "down", observedAt: "2026-01-01T12:05:00.000Z", source: "synthetic" });

    const open = await db.select().from(incidents).where(eq(incidents.serviceId, service.id));
    expect(open).toHaveLength(1);
  });

  it("resolves the open incident when a healthy event is the latest observation", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-1", status: "down", observedAt: "2026-01-01T12:00:00.000Z", source: "synthetic" });
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-2", status: "healthy", observedAt: "2026-01-01T12:10:00.000Z", source: "synthetic" });

    const [incident] = await db.select().from(incidents).where(eq(incidents.serviceId, service.id));
    expect(incident!.status).toBe("resolved");
    expect(incident!.resolvedAt!.toISOString()).toBe("2026-01-01T12:10:00.000Z");
  });

  it("is idempotent on (serviceId, externalId): re-sending the same event does not duplicate rows", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);
    const input = { serviceId: service.id, externalId: "ev-1", status: "down" as const, observedAt: "2026-01-01T12:00:00.000Z", source: "synthetic" };

    const first = await ingestHealthEvent(db, input);
    const second = await ingestHealthEvent(db, input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const rows = await db.select().from(healthEvents).where(eq(healthEvents.serviceId, service.id));
    expect(rows).toHaveLength(1);
  });

  it("handles out-of-order arrival: an earlier-observed 'down' event that arrives second still becomes the incident's first-unhealthy timestamp", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    // The 12:05 event is ingested first (e.g. it arrived over a faster network path).
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-later", status: "down", observedAt: "2026-01-01T12:05:00.000Z", source: "synthetic" });
    // The TRUE first-unhealthy event, at 12:00, arrives second.
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-earlier", status: "down", observedAt: "2026-01-01T12:00:00.000Z", source: "synthetic" });

    const [incident] = await db.select().from(incidents).where(eq(incidents.serviceId, service.id));
    expect(incident!.openedAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });

  it("does not resolve an incident when an out-of-order 'healthy' event arrives between two 'down' events", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-1", status: "down", observedAt: "2026-01-01T12:00:00.000Z", source: "synthetic" });
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-3", status: "down", observedAt: "2026-01-01T12:10:00.000Z", source: "synthetic" });
    // A stale "healthy" reading from 12:05 arrives last, after the 12:10 "down" reading.
    await ingestHealthEvent(db, { serviceId: service.id, externalId: "ev-2", status: "healthy", observedAt: "2026-01-01T12:05:00.000Z", source: "synthetic" });

    const [incident] = await db.select().from(incidents).where(eq(incidents.serviceId, service.id));
    expect(incident!.status).toBe("open");
  });
});
