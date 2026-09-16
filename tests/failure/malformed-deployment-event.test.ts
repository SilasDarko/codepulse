import { describe, expect, it } from "vitest";
import { deploymentEventSchema, healthEventSchema } from "@/src/lib/validation";

describe("malformed deployment event payloads", () => {
  it("rejects a payload missing required fields", () => {
    const result = deploymentEventSchema.safeParse({ serviceId: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    const result = deploymentEventSchema.safeParse({
      serviceId: 1,
      externalId: "d1",
      toSha: "abc",
      status: "not-a-real-status",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO startedAt", () => {
    const result = deploymentEventSchema.safeParse({
      serviceId: 1,
      externalId: "d1",
      toSha: "abc",
      status: "succeeded",
      startedAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed payload", () => {
    const result = deploymentEventSchema.safeParse({
      serviceId: 1,
      externalId: "d1",
      toSha: "abc",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("malformed health event payloads", () => {
  it("rejects an invalid health status", () => {
    const result = healthEventSchema.safeParse({
      serviceId: 1,
      externalId: "h1",
      status: "on_fire",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing serviceId", () => {
    const result = healthEventSchema.safeParse({
      externalId: "h1",
      status: "down",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("defaults source to 'manual' when omitted", () => {
    const result = healthEventSchema.safeParse({
      serviceId: 1,
      externalId: "h1",
      status: "down",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.source).toBe("manual");
  });
});
