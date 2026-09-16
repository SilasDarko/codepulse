import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/src/db/client";
import { ciRuns, commits, deployments, healthEvents, pullRequests, services } from "@/src/db/schema";

export interface TimelineEntry {
  type: "commit" | "pull_request" | "ci_run" | "deployment" | "health_event";
  at: string;
  summary: string;
  detail: Record<string, unknown>;
}

const DEFAULT_LIMIT = 200;

/** Merges every entity type touching one repo into a single chronological feed. Used by both GET /api/timeline/[repoId] and the /repos/[id] page. */
export async function buildTimeline(repoId: number, limit = DEFAULT_LIMIT): Promise<TimelineEntry[]> {
  const serviceRows = await db.select().from(services).where(eq(services.repoId, repoId));
  const serviceIds = serviceRows.map((s) => s.id);
  const serviceNameById = new Map(serviceRows.map((s) => [s.id, s.name]));

  const [commitRows, prRows, ciRunRows, deploymentRows, healthRows] = await Promise.all([
    db.select().from(commits).where(eq(commits.repoId, repoId)).orderBy(desc(commits.committedAt)).limit(limit),
    db.select().from(pullRequests).where(eq(pullRequests.repoId, repoId)).orderBy(desc(pullRequests.createdAt)).limit(limit),
    db.select().from(ciRuns).where(eq(ciRuns.repoId, repoId)).limit(limit),
    serviceIds.length ? db.select().from(deployments).where(inArray(deployments.serviceId, serviceIds)).limit(limit) : [],
    serviceIds.length ? db.select().from(healthEvents).where(inArray(healthEvents.serviceId, serviceIds)).limit(limit) : [],
  ]);

  const entries: TimelineEntry[] = [
    ...commitRows.map((c) => ({
      type: "commit" as const,
      at: c.committedAt.toISOString(),
      summary: `${c.sha.slice(0, 7)} ${c.message.split("\n")[0]}`,
      detail: { sha: c.sha, authorName: c.authorName },
    })),
    ...prRows.map((p) => ({
      type: "pull_request" as const,
      at: (p.mergedAt ?? p.createdAt).toISOString(),
      summary: `#${p.number} ${p.title}`,
      detail: { number: p.number, merged: Boolean(p.mergedAt) },
    })),
    ...ciRunRows
      .filter((r) => r.completedAt)
      .map((r) => ({
        type: "ci_run" as const,
        at: r.completedAt!.toISOString(),
        summary: `${r.workflowName || "workflow"}: ${r.conclusion ?? r.status}`,
        detail: { commitSha: r.commitSha, conclusion: r.conclusion },
      })),
    ...deploymentRows.map((d) => ({
      type: "deployment" as const,
      at: (d.completedAt ?? d.startedAt).toISOString(),
      summary: `deploy ${serviceNameById.get(d.serviceId) ?? d.serviceId} -> ${d.toSha.slice(0, 7)} (${d.status})`,
      detail: { serviceId: d.serviceId, toSha: d.toSha, status: d.status },
    })),
    ...healthRows.map((h) => ({
      type: "health_event" as const,
      at: h.observedAt.toISOString(),
      summary: `${serviceNameById.get(h.serviceId) ?? h.serviceId} is ${h.status}`,
      detail: { serviceId: h.serviceId, status: h.status },
    })),
  ];

  entries.sort((a, b) => b.at.localeCompare(a.at));
  return entries.slice(0, limit);
}
