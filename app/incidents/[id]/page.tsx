import { notFound } from "next/navigation";
import { getIncidentDetail } from "@/src/lib/incident-detail";

export const dynamic = "force-dynamic";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incidentId = Number(id);
  if (!Number.isInteger(incidentId)) notFound();

  const detail = await getIncidentDetail(incidentId);
  if (!detail) notFound();

  const { incident, service, candidates } = detail;

  return (
    <div>
      <h2>
        Incident #{incident.id} &mdash; {service?.name}
      </h2>
      <p style={{ color: "var(--text-dim)" }}>
        status <b style={{ color: incident.status === "open" ? "var(--danger)" : "var(--ok)" }}>{incident.status}</b>
        {" · "}first unhealthy at {incident.openedAt.toISOString()}
        {incident.resolvedAt ? ` · resolved at ${incident.resolvedAt.toISOString()}` : ""}
      </p>

      <h3 style={{ marginTop: 24 }}>Ranked candidates</h3>
      {candidates.length === 0 ? (
        <p style={{ color: "var(--text-dim)" }}>
          No candidates yet. <code>POST /api/incidents/{incident.id}/correlate</code> to compute them.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Type</th>
              <th>Candidate</th>
              <th>Score</th>
              <th>Time proximity</th>
              <th>File overlap</th>
              <th>CI signal</th>
              <th>PR risk</th>
              <th>Partial data</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const b = c.scoreBreakdown as {
                timeProximity: number;
                fileOverlap: number;
                ciSignal: number;
                prRisk: number;
                partialData: boolean;
              };
              const label =
                c.candidateType === "commit"
                  ? `${c.candidateRef.slice(0, 7)} ${c.commit?.message.split("\n")[0] ?? ""}`
                  : `#${c.candidateRef} ${c.pullRequest?.title ?? ""}`;
              return (
                <tr key={c.id}>
                  <td>{c.rank}</td>
                  <td>{c.candidateType}</td>
                  <td>{label}</td>
                  <td>
                    <b>{c.score.toFixed(3)}</b>
                  </td>
                  <td>{pct(b.timeProximity)}</td>
                  <td>{pct(b.fileOverlap)}</td>
                  <td>{pct(b.ciSignal)}</td>
                  <td>{pct(b.prRisk)}</td>
                  <td>{b.partialData ? "yes" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
