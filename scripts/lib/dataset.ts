// Generates a synthetic-but-structurally-realistic dataset and writes it
// straight into Postgres: normal engineering activity (routine commits,
// PRs, CI runs, deployments, periodic health checks) across several
// services, plus a configurable number of "incident scenarios" -- each one
// a deliberately injected regression with a KNOWN causative commit, so
// scripts/benchmark.ts can grade the correlation engine's top-1/top-3
// accuracy against ground truth it never sees.
//
// Nothing here is presented as real usage: this is exactly what `npm run
// seed` and `npm run benchmark` are for, and every row this writes lives
// under a repo named "codepulse-synth/monorepo".
import { sql, type Table } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import {
  repositories,
  services as servicesTable,
  commits,
  commitFiles,
  pullRequests,
  ciRuns,
  ciJobs,
  deployments,
  healthEvents,
  incidents,
  benchmarkGroundTruth,
} from "@/src/db/schema";
import { makeRng, randomInt, pick, chance, fakeSha } from "./rng";

const SERVICE_DEFS = [
  { name: "payments", pattern: "src/payments/**" },
  { name: "checkout", pattern: "src/checkout/**" },
  { name: "search", pattern: "src/search/**" },
  { name: "auth", pattern: "src/auth/**" },
  { name: "notifications", pattern: "src/notifications/**" },
  { name: "catalog", pattern: "src/catalog/**" },
] as const;

const AUTHORS = ["ada", "grace", "linus", "margaret", "dennis", "barbara"];
const RISKY_VERBS = ["Rework", "Overhaul", "Fast-track", "Rewrite"];
const ROUTINE_VERBS = ["Fix", "Add", "Update", "Tweak", "Clean up", "Bump"];
const NOUNS = [
  "retry logic",
  "cache layer",
  "error handling",
  "connection pool",
  "rate limiter",
  "config",
  "logging",
  "validation",
  "queue consumer",
  "timeout handling",
];
const FILE_KINDS = ["handler", "service", "client", "worker", "validator"];
type CiConclusionValue = "success" | "failure" | "cancelled" | "skipped";

export interface SeedOptions {
  seed: number;
  days: number;
  healthIntervalMinutes: number;
  incidentScenarios: number;
  routineCommitsPerServicePerDay: number;
  routineDeploymentsPerServicePerDay: number;
  backgroundCommits: number;
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  seed: 42,
  days: 10,
  healthIntervalMinutes: 3,
  incidentScenarios: 200,
  routineCommitsPerServicePerDay: 5,
  routineDeploymentsPerServicePerDay: 3,
  backgroundCommits: 300,
};

export interface GroundTruthRow {
  incidentId: number;
  serviceName: string;
  causativeCommitSha: string;
}

export interface SeedResult {
  options: SeedOptions;
  counts: Record<string, number>;
  totalCoreEvents: number;
  groundTruth: GroundTruthRow[];
  elapsedMs: number;
}

async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE
    benchmark_ground_truth, correlation_results, ingestion_checkpoints,
    incidents, health_events, deployment_steps, deployments, services,
    ci_jobs, ci_runs, pull_requests, commit_files, commits, repositories
    RESTART IDENTITY CASCADE`);
}

async function insertChunked<T extends Record<string, unknown>>(
  db: Database,
  table: Table,
  rows: T[],
  chunkSize = 1000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db.insert(table).values(rows.slice(i, i + chunkSize));
  }
}

async function insertChunkedReturning<T extends Record<string, unknown>, R>(
  db: Database,
  table: Table,
  rows: T[],
  returning: Record<string, unknown>,
  chunkSize = 1000,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    // @ts-expect-error -- generic over any of this file's insertable tables
    const batch = (await db.insert(table).values(rows.slice(i, i + chunkSize)).returning(returning)) as R[];
    out.push(...batch);
  }
  return out;
}

interface PlannedCommit {
  serviceIdx: number | null;
  scenarioIndex: number | null;
  sha: string;
  message: string;
  committedAt: Date;
  changedFiles: string[];
}

interface PlannedScenario {
  serviceIdx: number;
  incidentAt: Date;
  deployStart: Date;
  deployCompleted: Date;
  resolvedAt: Date | null;
}

export async function seedSyntheticDataset(db: Database, overrides: Partial<SeedOptions> = {}): Promise<SeedResult> {
  const options: SeedOptions = { ...DEFAULT_SEED_OPTIONS, ...overrides };
  const rng = makeRng(options.seed);
  const startedAt = Date.now();

  await resetDatabase(db);

  const [repo] = await db.insert(repositories).values({ owner: "codepulse-synth", name: "monorepo" }).returning();
  const serviceRows = await db
    .insert(servicesTable)
    .values(SERVICE_DEFS.map((s) => ({ repoId: repo!.id, name: s.name, pathPatterns: [s.pattern] })))
    .returning();

  const rangeStart = new Date("2026-01-01T00:00:00.000Z").getTime();
  const rangeEnd = rangeStart + options.days * 24 * 60 * 60 * 1000;
  const randomTime = (minDay = 0) => new Date(randomInt(rng, rangeStart + minDay * 86_400_000, rangeEnd));

  // ---- plan scenarios first (their timing drives the guilty commit/deployment) ----
  const scenarios: PlannedScenario[] = [];
  for (let i = 0; i < options.incidentScenarios; i++) {
    const incidentAt = randomTime(1); // leave >=1 day of history for the lookback window
    // A well-instrumented service (this generator's health checks run every
    // healthIntervalMinutes) typically surfaces a regression within tens of
    // minutes of the bad deploy, not hours -- see DESIGN_DECISIONS.md.
    const deployDelayMin = randomInt(rng, 5, 25);
    const deployDurationMin = randomInt(rng, 1, 4);
    const deployStart = new Date(incidentAt.getTime() - deployDelayMin * 60_000);
    const deployCompleted = new Date(deployStart.getTime() + deployDurationMin * 60_000);
    const resolvedAt = chance(rng, 0.95) ? new Date(incidentAt.getTime() + randomInt(rng, 15, 180) * 60_000) : null;
    scenarios.push({ serviceIdx: randomInt(rng, 0, SERVICE_DEFS.length - 1), incidentAt, deployStart, deployCompleted, resolvedAt });
  }

  // ---- plan commits: background (unrelated), routine (per service), guilty (one per scenario) ----
  const plannedCommits: PlannedCommit[] = [];

  for (let i = 0; i < options.backgroundCommits; i++) {
    plannedCommits.push({
      serviceIdx: null,
      scenarioIndex: null,
      sha: fakeSha(rng),
      message: pick(rng, ["Update docs", "Bump dependency versions", "Tidy up README", "Add code comments", "CI config tweak"]),
      committedAt: randomTime(),
      changedFiles: [pick(rng, ["README.md", "docs/guide.md", ".github/workflows/ci.yml", "package.json"])],
    });
  }

  for (let s = 0; s < serviceRows.length; s++) {
    const service = SERVICE_DEFS[s]!;
    const total = options.routineCommitsPerServicePerDay * options.days;
    for (let i = 0; i < total; i++) {
      plannedCommits.push({
        serviceIdx: s,
        scenarioIndex: null,
        sha: fakeSha(rng),
        message: `${pick(rng, ROUTINE_VERBS)} ${service.name} ${pick(rng, NOUNS)}`,
        committedAt: randomTime(),
        changedFiles: [`src/${service.name}/${pick(rng, FILE_KINDS)}.ts`],
      });
    }
  }

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]!;
    const service = SERVICE_DEFS[scenario.serviceIdx]!;
    const changedFiles = [`src/${service.name}/${pick(rng, FILE_KINDS)}.ts`];
    if (chance(rng, 0.2)) changedFiles.push(`src/${service.name}/config.yml`);
    plannedCommits.push({
      serviceIdx: scenario.serviceIdx,
      scenarioIndex: i,
      sha: fakeSha(rng),
      message: `${pick(rng, RISKY_VERBS)} ${service.name} ${pick(rng, NOUNS)}`,
      committedAt: scenario.deployStart,
      changedFiles,
    });
  }

  const commitRows = await insertChunkedReturning<Record<string, unknown>, { id: number; sha: string }>(
    db,
    commits,
    plannedCommits.map((c) => ({
      repoId: repo!.id,
      sha: c.sha,
      parentShas: [],
      authorName: pick(rng, AUTHORS),
      message: c.message,
      committedAt: c.committedAt,
    })),
    { id: commits.id, sha: commits.sha },
  );
  const commitIdBySha = new Map(commitRows.map((r) => [r.sha, r.id]));

  await insertChunked(
    db,
    commitFiles,
    plannedCommits.flatMap((c) => c.changedFiles.map((filePath) => ({ commitId: commitIdBySha.get(c.sha)!, filePath, status: "modified" }))),
  );

  // ---- PRs + CI runs + CI jobs for guilty commits (always) and a share of routine commits ----
  interface PlannedPr {
    commit: PlannedCommit;
    number: number;
    additions: number;
    deletions: number;
    conclusion: CiConclusionValue;
  }
  const plannedPrs: PlannedPr[] = [];
  let prNumber = 1;
  for (const c of plannedCommits) {
    if (c.serviceIdx === null) continue;
    const isGuilty = c.scenarioIndex !== null;
    if (!isGuilty && !chance(rng, 0.75)) continue;

    plannedPrs.push({
      commit: c,
      number: prNumber++,
      additions: isGuilty ? randomInt(rng, 150, 900) : randomInt(rng, 5, 150),
      deletions: isGuilty ? randomInt(rng, 80, 400) : randomInt(rng, 2, 80),
      conclusion: isGuilty
        ? pick<CiConclusionValue>(rng, ["failure", "failure", "cancelled", "success"])
        : chance(rng, 0.08)
          ? "failure"
          : "success",
    });
  }

  const prRows = await insertChunkedReturning<Record<string, unknown>, { id: number; number: number }>(
    db,
    pullRequests,
    plannedPrs.map((p) => ({
      repoId: repo!.id,
      number: p.number,
      title: p.commit.message,
      authorLogin: pick(rng, AUTHORS),
      baseSha: "base",
      headSha: p.commit.sha,
      additions: p.additions,
      deletions: p.deletions,
      changedFilesCount: p.commit.changedFiles.length,
      labels: [],
      mergedAt: p.commit.committedAt,
    })),
    { id: pullRequests.id, number: pullRequests.number },
  );
  const prIdByNumber = new Map(prRows.map((r) => [r.number, r.id]));

  const ciRunRows = await insertChunkedReturning<Record<string, unknown>, { id: number; pullRequestId: number }>(
    db,
    ciRuns,
    plannedPrs.map((p) => ({
      repoId: repo!.id,
      pullRequestId: prIdByNumber.get(p.number)!,
      externalId: `synthetic-${p.number}`,
      commitSha: p.commit.sha,
      workflowName: "CI",
      status: "completed",
      conclusion: p.conclusion,
      startedAt: p.commit.committedAt,
      completedAt: p.commit.committedAt,
    })),
    { id: ciRuns.id, pullRequestId: ciRuns.pullRequestId },
  );
  const ciRunIdByPrId = new Map(ciRunRows.map((r) => [r.pullRequestId, r.id]));
  const conclusionByPrNumber = new Map(plannedPrs.map((p) => [p.number, p.conclusion]));

  await insertChunked(
    db,
    ciJobs,
    plannedPrs.flatMap((p) => {
      const ciRunId = ciRunIdByPrId.get(prIdByNumber.get(p.number)!)!;
      const jobCount = randomInt(rng, 2, 4);
      return Array.from({ length: jobCount }, (_, j) => ({
        ciRunId,
        name: `job-${j + 1}`,
        status: "completed",
        conclusion: conclusionByPrNumber.get(p.number)!,
      }));
    }),
  );

  // ---- deployments: routine (per service) + guilty (one per scenario) ----
  const routineCommitsByService = new Map<number, PlannedCommit[]>();
  for (const c of plannedCommits) {
    if (c.serviceIdx === null || c.scenarioIndex !== null) continue;
    const list = routineCommitsByService.get(c.serviceIdx) ?? [];
    list.push(c);
    routineCommitsByService.set(c.serviceIdx, list);
  }

  const plannedDeployments: { serviceIdx: number; toSha: string; startedAt: Date; completedAt: Date }[] = [];
  for (let s = 0; s < serviceRows.length; s++) {
    const pool = routineCommitsByService.get(s) ?? [];
    if (pool.length === 0) continue;
    const total = options.routineDeploymentsPerServicePerDay * options.days;
    for (let i = 0; i < total; i++) {
      const c = pick(rng, pool);
      const startedAt = new Date(Math.min(c.committedAt.getTime() + randomInt(rng, 0, 180) * 60_000, rangeEnd));
      plannedDeployments.push({ serviceIdx: s, toSha: c.sha, startedAt, completedAt: new Date(startedAt.getTime() + randomInt(rng, 1, 10) * 60_000) });
    }
  }
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]!;
    const guiltyCommit = plannedCommits.find((c) => c.scenarioIndex === i)!;
    plannedDeployments.push({ serviceIdx: scenario.serviceIdx, toSha: guiltyCommit.sha, startedAt: scenario.deployStart, completedAt: scenario.deployCompleted });
  }

  await insertChunked(
    db,
    deployments,
    plannedDeployments.map((d, i) => ({
      serviceId: serviceRows[d.serviceIdx]!.id,
      externalId: `deploy-${i}`,
      fromSha: null,
      toSha: d.toSha,
      status: "succeeded" as const,
      startedAt: d.startedAt,
      completedAt: d.completedAt,
    })),
  );

  // ---- health events: dense periodic background noise + scenario down/resolve pairs ----
  const plannedHealthEvents: { serviceIdx: number; externalId: string; status: "healthy" | "degraded" | "down"; observedAt: Date }[] = [];
  for (let s = 0; s < serviceRows.length; s++) {
    let seq = 0;
    for (let t = rangeStart; t < rangeEnd; t += options.healthIntervalMinutes * 60_000) {
      const status = chance(rng, 0.985) ? "healthy" : pick<"degraded" | "down">(rng, ["degraded", "down"]);
      plannedHealthEvents.push({ serviceIdx: s, externalId: `periodic-${s}-${seq++}`, status, observedAt: new Date(t) });
    }
  }
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i]!;
    plannedHealthEvents.push({ serviceIdx: scenario.serviceIdx, externalId: `scenario-${i}-down`, status: "down", observedAt: scenario.incidentAt });
    if (scenario.resolvedAt) {
      plannedHealthEvents.push({ serviceIdx: scenario.serviceIdx, externalId: `scenario-${i}-healthy`, status: "healthy", observedAt: scenario.resolvedAt });
    }
  }

  await insertChunked(
    db,
    healthEvents,
    plannedHealthEvents.map((h) => ({
      serviceId: serviceRows[h.serviceIdx]!.id,
      externalId: h.externalId,
      status: h.status,
      observedAt: h.observedAt,
      source: "synthetic",
    })),
  );

  // ---- incidents (written directly -- see BENCHMARKS.md methodology) + ground truth ----
  const incidentRows = await insertChunkedReturning<Record<string, unknown>, { id: number }>(
    db,
    incidents,
    scenarios.map((scenario) => ({
      serviceId: serviceRows[scenario.serviceIdx]!.id,
      openedAt: scenario.incidentAt,
      resolvedAt: scenario.resolvedAt,
      status: scenario.resolvedAt && chance(rng, 0.95) ? "resolved" : "open",
    })),
    { id: incidents.id },
  );

  const groundTruth: GroundTruthRow[] = scenarios.map((scenario, i) => ({
    incidentId: incidentRows[i]!.id,
    serviceName: SERVICE_DEFS[scenario.serviceIdx]!.name,
    causativeCommitSha: plannedCommits.find((c) => c.scenarioIndex === i)!.sha,
  }));

  await insertChunked(
    db,
    benchmarkGroundTruth,
    groundTruth.map((g) => ({ incidentId: g.incidentId, causativeCommitSha: g.causativeCommitSha })),
  );

  const counts: Record<string, number> = {
    repositories: 1,
    services: serviceRows.length,
    commits: commitRows.length,
    commit_files: plannedCommits.reduce((n, c) => n + c.changedFiles.length, 0),
    pull_requests: prRows.length,
    ci_runs: ciRunRows.length,
    deployments: plannedDeployments.length,
    health_events: plannedHealthEvents.length,
    incidents: incidentRows.length,
  };

  return {
    options,
    counts,
    totalCoreEvents: counts.commits! + counts.pull_requests! + counts.ci_runs! + counts.deployments! + counts.health_events!,
    groundTruth,
    elapsedMs: Date.now() - startedAt,
  };
}
