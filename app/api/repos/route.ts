import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/db/client";
import { repositories } from "@/src/db/schema";
import { withMetrics, jsonError } from "@/src/lib/http";

const createRepoSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
});

export const GET = withMetrics("/api/repos", async () => {
  const rows = await db.select().from(repositories);
  return NextResponse.json(rows);
});

export const POST = withMetrics("/api/repos", async (req) => {
  const parsed = createRepoSchema.safeParse(await req.json());
  if (!parsed.success) return jsonError("invalid repo payload", 400, parsed.error.flatten());

  const [row] = await db.insert(repositories).values(parsed.data).returning();
  return NextResponse.json(row, { status: 201 });
});
