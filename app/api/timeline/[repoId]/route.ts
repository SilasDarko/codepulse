import { NextResponse } from "next/server";
import { buildTimeline } from "@/src/lib/timeline";
import { withMetrics, jsonError } from "@/src/lib/http";

const DEFAULT_LIMIT = 200;

export const GET = withMetrics<[{ params: Promise<{ repoId: string }> }]>("/api/timeline/[repoId]", async (req, { params }) => {
  const { repoId: repoIdParam } = await params;
  const repoId = Number(repoIdParam);
  if (!Number.isInteger(repoId)) return jsonError("repoId must be an integer", 400);

  const url = new URL(req.url);
  const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT));

  const entries = await buildTimeline(repoId, limit);
  return NextResponse.json({ repoId, entries });
});
