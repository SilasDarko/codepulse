import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/db/client";
import { services } from "@/src/db/schema";
import { withMetrics, jsonError } from "@/src/lib/http";

const createServiceSchema = z.object({
  repoId: z.number().int().positive(),
  name: z.string().min(1),
  pathPatterns: z.array(z.string()).default([]),
});

export const GET = withMetrics("/api/services", async () => {
  const rows = await db.select().from(services);
  return NextResponse.json(rows);
});

export const POST = withMetrics("/api/services", async (req) => {
  const parsed = createServiceSchema.safeParse(await req.json());
  if (!parsed.success) return jsonError("invalid service payload", 400, parsed.error.flatten());

  const [row] = await db.insert(services).values(parsed.data).returning();
  return NextResponse.json(row, { status: 201 });
});
