import { and, asc, eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { commits, correlationResults, incidents, pullRequests, services } from "@/src/db/schema";

export type IncidentDetail = Awaited<ReturnType<typeof getIncidentDetail>>;

/** Shared by GET /api/incidents/[id] and the /incidents/[id] page -- one query path, one place to fix. */
export async function getIncidentDetail(id: number) {
  const [incident] = await db.select().from(incidents).where(eq(incidents.id, id));
  if (!incident) return null;

  const [service] = await db.select().from(services).where(eq(services.id, incident.serviceId));

  const results = await db
    .select()
    .from(correlationResults)
    .where(eq(correlationResults.incidentId, id))
    .orderBy(asc(correlationResults.rank));

  const candidates = await Promise.all(
    results.map(async (r) => {
      if (r.candidateType === "commit") {
        const [c] = await db
          .select()
          .from(commits)
          .where(and(eq(commits.repoId, service!.repoId), eq(commits.sha, r.candidateRef)));
        return { ...r, commit: c ?? null, pullRequest: null };
      }
      const [p] = await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, service!.repoId), eq(pullRequests.number, Number(r.candidateRef))));
      return { ...r, commit: null, pullRequest: p ?? null };
    }),
  );

  return { incident, service, candidates };
}
