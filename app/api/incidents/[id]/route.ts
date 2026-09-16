import { NextResponse } from "next/server";
import { getIncidentDetail } from "@/src/lib/incident-detail";
import { withMetrics, jsonError } from "@/src/lib/http";

export const GET = withMetrics<[{ params: Promise<{ id: string }> }]>("/api/incidents/[id]", async (_req, { params }) => {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) return jsonError("id must be an integer", 400);

  const detail = await getIncidentDetail(id);
  if (!detail) return jsonError("incident not found", 404);

  return NextResponse.json(detail);
});
