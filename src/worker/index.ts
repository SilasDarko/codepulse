import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { db } from "@/src/db/client";
import { workerLagSeconds } from "@/src/metrics/registry";
import { toGithubApiClient } from "@/src/ingestion/github-client";
import { startMetricsServer } from "./metrics-server";
import { resolveTrackedRepo, runPollCycle, type GithubIngestionTarget } from "./poll-cycle";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 9091);

async function main(): Promise<void> {
  startMetricsServer(METRICS_PORT);
  console.log(`[worker] metrics on :${METRICS_PORT}/metrics, polling every ${POLL_INTERVAL_MS}ms`);

  let github: GithubIngestionTarget | null = null;
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    const repo = await resolveTrackedRepo(db, process.env.GITHUB_REPO);
    github = { client: toGithubApiClient(new Octokit({ auth: process.env.GITHUB_TOKEN })), repo };
    console.log(`[worker] tracking ${process.env.GITHUB_REPO} (repo id ${repo.id})`);
  } else {
    console.log("[worker] GITHUB_TOKEN/GITHUB_REPO not set -- skipping GitHub ingestion, correlation-only mode");
  }

  let lastCycleCompletedAt = Date.now();
  setInterval(() => workerLagSeconds.set((Date.now() - lastCycleCompletedAt) / 1000), 1000);

  // Deliberately not a queue/scheduler library -- this is a plain poll loop.
  // See DESIGN_DECISIONS.md for why that's enough at this project's scale.
  for (;;) {
    await runPollCycle(db, github);
    lastCycleCompletedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[worker] fatal error:", err);
  process.exit(1);
});
