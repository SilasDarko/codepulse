import { NextResponse } from "next/server";
import { healthEventSchema } from "@/src/lib/validation";
import { ingestHealthEvent } from "@/src/ingestion/health-ingest";
import { db } from "@/src/db/client";
import { withMetrics, jsonError } from "@/src/lib/http";
import { ingestionErrorsTotal } from "@/src/metrics/registry";

export const POST = withMetrics("/api/health-events", async (req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("request body must be valid JSON", 400);
  }

  const parsed = healthEventSchema.safeParse(body);
  if (!parsed.success) {
    ingestionErrorsTotal.inc({ source: "health_webhook", reason: "validation" });
    return jsonError("malformed health event", 400, parsed.error.flatten());
  }

  const result = await ingestHealthEvent(db, parsed.data);
  return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
});
