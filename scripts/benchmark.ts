// `npm run benchmark` -- the script behind BENCHMARKS.md's numbers.
//
// 1. Seeds a fresh synthetic dataset sized to exceed 25,000 core ingested
//    events (commits + PRs + CI runs + deployments + health events), timing
//    the bulk insert for an ingestion-throughput figure.
// 2. Runs the real correlation engine (src/correlation/compute.ts) against
//    every seeded incident, timing each call and grading its top-ranked
//    candidate against the ground truth the generator recorded (and that
//    the correlation engine itself never sees).
// 3. Fires concurrent HTTP requests at the running app's timeline and
//    incident-detail API routes to measure real p50/p95 latency.
//
// Every number printed here is measured on this run, not hard-coded --
// rerun it and you'll get this run's numbers, not a copy of BENCHMARKS.md.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/src/db/client";
import { pullRequests, repositories } from "@/src/db/schema";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { correlationResults } from "@/src/db/schema";
import { seedSyntheticDataset, type GroundTruthRow } from "./lib/dataset";

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const API_REQUESTS = 300;
const API_CONCURRENCY = 20;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

async function assertServerReachable(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/api/metrics`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(
      `\nCan't reach ${BASE_URL} (${(err as Error).message}).\n` +
        `The API-latency phase needs the app actually running.\n` +
        `Start it in another terminal first: npm run build && npm start (or npm run dev), then re-run npm run benchmark.\n`,
    );
    process.exit(1);
  }
}

async function measureEndpointLatency(
  urls: string[],
  totalRequests: number,
  concurrency: number,
): Promise<{ p50: number; p95: number; max: number; count: number; errorCount: number }> {
  const durations: number[] = [];
  let errorCount = 0;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= totalRequests) return;
      const url = urls[i % urls.length]!;
      const start = performance.now();
      try {
        const res = await fetch(url);
        await res.arrayBuffer();
        durations.push(performance.now() - start);
        if (!res.ok) errorCount++;
      } catch {
        errorCount++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const sorted = durations.slice().sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0, count: sorted.length, errorCount };
}

/** Resolves a ranked candidate back to the commit sha it's ultimately about, whether it surfaced as a commit or a pull_request row. */
async function candidateCommitSha(repoId: number, candidateType: string, candidateRef: string): Promise<string | null> {
  if (candidateType === "commit") return candidateRef;
  const [pr] = await db
    .select({ headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, Number(candidateRef))));
  return pr?.headSha ?? null;
}

async function measureCorrelation(repoId: number, groundTruth: GroundTruthRow[]) {
  const durationsMs: number[] = [];
  let top1Hits = 0;
  let top3Hits = 0;

  for (const truth of groundTruth) {
    const start = performance.now();
    await computeCorrelationForIncident(db, truth.incidentId);
    durationsMs.push(performance.now() - start);

    const ranked = await db
      .select({ candidateType: correlationResults.candidateType, candidateRef: correlationResults.candidateRef, rank: correlationResults.rank })
      .from(correlationResults)
      .where(eq(correlationResults.incidentId, truth.incidentId));
    ranked.sort((a, b) => a.rank - b.rank);

    const resolvedTop3 = await Promise.all(
      ranked.slice(0, 3).map((r) => candidateCommitSha(repoId, r.candidateType, r.candidateRef)),
    );
    if (resolvedTop3[0] === truth.causativeCommitSha) top1Hits++;
    if (resolvedTop3.includes(truth.causativeCommitSha)) top3Hits++;
  }

  const sorted = durationsMs.slice().sort((a, b) => a - b);
  return {
    count: groundTruth.length,
    top1Accuracy: top1Hits / groundTruth.length,
    top3Accuracy: top3Hits / groundTruth.length,
    durationP50Ms: percentile(sorted, 0.5),
    durationP95Ms: percentile(sorted, 0.95),
  };
}

async function main() {
  console.log(`Seeding synthetic dataset (this truncates the app database)...`);
  const seedResult = await seedSyntheticDataset(db);
  const ingestionEventsPerSec = seedResult.totalCoreEvents / (seedResult.elapsedMs / 1000);

  console.log(`Seeded ${seedResult.totalCoreEvents} core events in ${seedResult.elapsedMs}ms (${ingestionEventsPerSec.toFixed(0)} events/sec).`);
  console.log(`Running correlation over ${seedResult.groundTruth.length} seeded incidents...`);

  const [repo] = await db.select().from(repositories).where(and(eq(repositories.owner, "codepulse-synth"), eq(repositories.name, "monorepo")));
  const correlation = await measureCorrelation(repo!.id, seedResult.groundTruth);

  console.log(`Checking ${BASE_URL} is reachable for the API-latency phase...`);
  await assertServerReachable();

  const timelineUrls = [`${BASE_URL}/api/timeline/${repo!.id}`];
  const incidentUrls = seedResult.groundTruth.slice(0, 20).map((g) => `${BASE_URL}/api/incidents/${g.incidentId}`);

  console.log(`Measuring GET /api/timeline/[repoId] latency (${API_REQUESTS} requests, concurrency ${API_CONCURRENCY})...`);
  const timelineLatency = await measureEndpointLatency(timelineUrls, API_REQUESTS, API_CONCURRENCY);

  console.log(`Measuring GET /api/incidents/[id] latency (${API_REQUESTS} requests, concurrency ${API_CONCURRENCY})...`);
  const incidentLatency = await measureEndpointLatency(incidentUrls, API_REQUESTS, API_CONCURRENCY);

  const report = {
    generatedAt: new Date().toISOString(),
    seed: seedResult.options,
    ingestion: {
      totalCoreEvents: seedResult.totalCoreEvents,
      elapsedMs: seedResult.elapsedMs,
      eventsPerSec: Math.round(ingestionEventsPerSec),
      tableCounts: seedResult.counts,
    },
    correlation,
    apiLatency: { timeline: timelineLatency, incidentDetail: incidentLatency },
  };

  console.log("\n=== BENCHMARK RESULTS ===\n");
  console.log(`Ingested events:        ${report.ingestion.totalCoreEvents} (target: 25,000+)`);
  console.log(`Ingestion throughput:   ${report.ingestion.eventsPerSec} events/sec`);
  console.log(`Correlation duration:   p50 ${correlation.durationP50Ms.toFixed(2)}ms, p95 ${correlation.durationP95Ms.toFixed(2)}ms`);
  console.log(`Localization accuracy:  top-1 ${(correlation.top1Accuracy * 100).toFixed(1)}%, top-3 ${(correlation.top3Accuracy * 100).toFixed(1)}% (n=${correlation.count})`);
  console.log(`Timeline API latency:   p50 ${timelineLatency.p50.toFixed(2)}ms, p95 ${timelineLatency.p95.toFixed(2)}ms (${timelineLatency.count} reqs, ${timelineLatency.errorCount} errors)`);
  console.log(`Incident API latency:   p50 ${incidentLatency.p50.toFixed(2)}ms, p95 ${incidentLatency.p95.toFixed(2)}ms (${incidentLatency.count} reqs, ${incidentLatency.errorCount} errors)`);

  await mkdir("benchmark-results", { recursive: true });
  const outPath = `benchmark-results/${report.generatedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
