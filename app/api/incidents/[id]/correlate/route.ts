import { NextResponse } from "next/server";
import { db } from "@/src/db/client";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { withMetrics, jsonError } from "@/src/lib/http";

export const POST = withMetrics<[{ params: Promise<{ id: string }> }]>(
  "/api/incidents/[id]/correlate",
  async (_req, { params }) => {
    const { id: idParam } = await params;
    const id = Number(idParam);
    if (!Number.isInteger(id)) return jsonError("id must be an integer", 400);

    try {
      const ranked = await computeCorrelationForIncident(db, id);
      return NextResponse.json({ incidentId: id, candidateCount: ranked.length });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        return jsonError("incident not found", 404);
      }
      throw err;
    }
  },
);
