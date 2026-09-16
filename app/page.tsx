import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { incidents, repositories, services } from "@/src/db/schema";

export const dynamic = "force-dynamic";

async function getDashboardData() {
  const repos = await db.select().from(repositories);
  const openIncidents = await db
    .select({
      id: incidents.id,
      openedAt: incidents.openedAt,
      serviceName: services.name,
      repoId: services.repoId,
    })
    .from(incidents)
    .innerJoin(services, eq(incidents.serviceId, services.id))
    .where(eq(incidents.status, "open"))
    .orderBy(desc(incidents.openedAt));

  return { repos, openIncidents };
}

export default async function DashboardPage() {
  const { repos, openIncidents } = await getDashboardData();

  return (
    <div>
      <h2>Open incidents</h2>
      {openIncidents.length === 0 ? (
        <p style={{ color: "var(--text-dim)" }}>None. Post a health event with status &quot;down&quot; to open one.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Opened at</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {openIncidents.map((inc) => (
              <tr key={inc.id}>
                <td>{inc.serviceName}</td>
                <td>{inc.openedAt.toISOString()}</td>
                <td>
                  <Link href={`/incidents/${inc.id}`}>view evidence &rarr;</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 32 }}>Tracked repositories</h2>
      {repos.length === 0 ? (
        <p style={{ color: "var(--text-dim)" }}>
          None yet. <code>POST /api/repos</code> to add one, or run <code>npm run seed</code> for synthetic data.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.owner}/{r.name}
                </td>
                <td>
                  <Link href={`/repos/${r.id}`}>timeline &rarr;</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
