import { NextResponse } from "next/server";
import { deploymentEventSchema } from "@/src/lib/validation";
import { ingestDeployment } from "@/src/ingestion/deployment-ingest";
import { db } from "@/src/db/client";
import { withMetrics, jsonError } from "@/src/lib/http";
import { ingestionErrorsTotal } from "@/src/metrics/registry";

export const POST = withMetrics("/api/deployments", async (req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("request body must be valid JSON", 400);
  }

  const parsed = deploymentEventSchema.safeParse(body);
  if (!parsed.success) {
    ingestionErrorsTotal.inc({ source: "deployment_webhook", reason: "validation" });
    return jsonError("malformed deployment event", 400, parsed.error.flatten());
  }

  const result = await ingestDeployment(db, parsed.data);
  return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
});
