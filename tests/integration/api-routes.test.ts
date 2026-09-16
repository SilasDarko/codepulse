import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, truncateAll } from "../helpers/db";
import { createRepo, createService } from "../helpers/fixtures";

import { POST as postDeployment } from "@/app/api/deployments/route";
import { POST as postHealthEvent } from "@/app/api/health-events/route";
import { GET as getTimeline } from "@/app/api/timeline/[repoId]/route";
import { GET as getIncident } from "@/app/api/incidents/[id]/route";
import { POST as postCorrelate } from "@/app/api/incidents/[id]/correlate/route";
import { GET as getMetrics } from "@/app/api/metrics/route";
import { db } from "@/src/db/client";
import { incidents } from "@/src/db/schema";
import { eq } from "drizzle-orm";

beforeEach(truncateAll);
afterAll(closeDb);

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", { method: "POST", body: JSON.stringify(body) });
}

describe("POST /api/deployments", () => {
  it("accepts a well-formed deployment and returns 201", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    const res = await postDeployment(
      jsonRequest({
        serviceId: service.id,
        externalId: "d1",
        toSha: "abc",
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(res.status).toBe(201);
  });

  it("returns 400 with validation details for a malformed body", async () => {
    const res = await postDeployment(jsonRequest({ serviceId: "not-a-number" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 for a non-JSON body instead of throwing", async () => {
    const res = await postDeployment(new Request("http://localhost/test", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/health-events", () => {
  it("accepts a well-formed event and opens an incident", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);

    const res = await postHealthEvent(
      jsonRequest({ serviceId: service.id, externalId: "h1", status: "down", observedAt: "2026-01-01T00:00:00.000Z" }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.incidentId).not.toBeNull();
  });
});

describe("GET /api/timeline/[repoId]", () => {
  it("merges deployments and health events for the repo's services, newest first", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id);
    await postHealthEvent(
      jsonRequest({ serviceId: service.id, externalId: "h1", status: "down", observedAt: "2026-01-01T12:00:00.000Z" }),
    );
    await postDeployment(
      jsonRequest({ serviceId: service.id, externalId: "d1", toSha: "abc", status: "succeeded", startedAt: "2026-01-01T11:00:00.000Z" }),
    );

    const res = await getTimeline(new Request(`http://localhost/api/timeline/${repo.id}`), {
      params: Promise.resolve({ repoId: String(repo.id) }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    expect(body.entries[0].type).toBe("health_event"); // newest first
  });

  it("returns 400 for a non-numeric repoId", async () => {
    const res = await getTimeline(new Request("http://localhost/api/timeline/abc"), {
      params: Promise.resolve({ repoId: "abc" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/incidents/[id] and POST correlate", () => {
  it("recomputes and returns ranked candidates for an incident", async () => {
    const repo = await createRepo();
    const service = await createService(repo.id, { pathPatterns: ["src/**"] });

    const healthRes = await postHealthEvent(
      jsonRequest({ serviceId: service.id, externalId: "h1", status: "down", observedAt: "2026-01-01T12:00:00.000Z" }),
    );
    const { incidentId } = await healthRes.json();

    await db.update(incidents).set({ openedAt: new Date("2026-01-01T12:00:00.000Z") }).where(eq(incidents.id, incidentId));
    await postDeployment(
      jsonRequest({ serviceId: service.id, externalId: "d1", toSha: "abc", status: "succeeded", startedAt: "2026-01-01T11:55:00.000Z" }),
    );

    const correlateRes = await postCorrelate(new Request("http://localhost/test", { method: "POST" }), {
      params: Promise.resolve({ id: String(incidentId) }),
    });
    expect(correlateRes.status).toBe(200);

    const getRes = await getIncident(new Request("http://localhost/test"), { params: Promise.resolve({ id: String(incidentId) }) });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.incident.id).toBe(incidentId);
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  it("returns 404 for an incident that does not exist", async () => {
    const res = await getIncident(new Request("http://localhost/test"), { params: Promise.resolve({ id: "999999" }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/metrics", () => {
  it("serves Prometheus exposition text", async () => {
    const res = await getMetrics();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("codepulse_api_request_duration_seconds");
  });
});
