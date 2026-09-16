import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/src/db/client";
import { repositories } from "@/src/db/schema";
import { buildTimeline } from "@/src/lib/timeline";

export const dynamic = "force-dynamic";

const TYPE_COLOR: Record<string, string> = {
  commit: "var(--text-dim)",
  pull_request: "var(--accent)",
  ci_run: "var(--warning)",
  deployment: "var(--ok)",
  health_event: "var(--danger)",
};

export default async function RepoTimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repoId = Number(id);
  if (!Number.isInteger(repoId)) notFound();

  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  if (!repo) notFound();

  const entries = await buildTimeline(repoId);

  return (
    <div>
      <h2>
        {repo.owner}/{repo.name}
      </h2>
      <p style={{ color: "var(--text-dim)" }}>{entries.length} events, newest first</p>

      {entries.length === 0 ? (
        <p style={{ color: "var(--text-dim)" }}>
          Nothing ingested yet. Run the worker with GITHUB_TOKEN/GITHUB_REPO set, or <code>npm run seed</code>.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Event</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td style={{ whiteSpace: "nowrap", color: "var(--text-dim)" }}>{e.at}</td>
                <td style={{ color: TYPE_COLOR[e.type], whiteSpace: "nowrap" }}>{e.type}</td>
                <td>{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
