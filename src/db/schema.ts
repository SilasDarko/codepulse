// Drizzle schema for CodePulse. Every table maps to one of the CORE ENTITIES
// from the spec: repository, commit, pull request, CI run, deployment,
// service, health event, incident. `ingestionCheckpoints` supports resumable
// ingestion; `correlationResults` stores the deterministic scorer's output;
// `benchmarkGroundTruth` is intentionally NOT part of the domain model -- it
// only exists so scripts/benchmark.ts can grade its own seeded scenarios,
// and nothing in the app reads it when computing a real correlation.
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  real,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const deploymentStatusEnum = pgEnum("deployment_status", [
  "in_progress",
  "succeeded",
  "failed",
  "rolled_back",
]);

export const healthStatusEnum = pgEnum("health_status", ["healthy", "degraded", "down"]);

export const incidentStatusEnum = pgEnum("incident_status", ["open", "resolved"]);

export const ciConclusionEnum = pgEnum("ci_conclusion", [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "pending", // job/run hasn't finished -- see "partial CI data" handling in correlation
]);

export const candidateTypeEnum = pgEnum("candidate_type", ["commit", "pull_request"]);

// ---------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------
export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    githubId: integer("github_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repositories_owner_name_idx").on(t.owner, t.name)],
);

// ---------------------------------------------------------------------------
// commit (+ the files it touched)
// ---------------------------------------------------------------------------
export const commits = pgTable(
  "commits",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    parentShas: text("parent_shas").array().notNull().default([]),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    message: text("message").notNull().default(""),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("commits_repo_sha_idx").on(t.repoId, t.sha),
    index("commits_committed_at_idx").on(t.committedAt),
  ],
);

export const commitFiles = pgTable(
  "commit_files",
  {
    id: serial("id").primaryKey(),
    commitId: integer("commit_id")
      .notNull()
      .references(() => commits.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    status: text("status").notNull().default("modified"), // added | modified | removed
  },
  (t) => [index("commit_files_commit_id_idx").on(t.commitId), index("commit_files_path_idx").on(t.filePath)],
);

// ---------------------------------------------------------------------------
// pull request
// ---------------------------------------------------------------------------
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull().default(""),
    authorLogin: text("author_login"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    changedFilesCount: integer("changed_files_count").notNull().default(0),
    labels: text("labels").array().notNull().default([]),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pull_requests_repo_number_idx").on(t.repoId, t.number),
    index("pull_requests_merged_at_idx").on(t.mergedAt),
  ],
);

// ---------------------------------------------------------------------------
// CI run (+ its jobs)
// ---------------------------------------------------------------------------
export const ciRuns = pgTable(
  "ci_runs",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pullRequestId: integer("pull_request_id").references(() => pullRequests.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id").notNull(), // GitHub workflow run id
    commitSha: text("commit_sha").notNull(),
    workflowName: text("workflow_name").notNull().default(""),
    status: text("status").notNull().default("completed"), // queued | in_progress | completed
    conclusion: ciConclusionEnum("conclusion"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ci_runs_repo_external_id_idx").on(t.repoId, t.externalId),
    index("ci_runs_commit_sha_idx").on(t.commitSha),
  ],
);

export const ciJobs = pgTable(
  "ci_jobs",
  {
    id: serial("id").primaryKey(),
    ciRunId: integer("ci_run_id")
      .notNull()
      .references(() => ciRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("completed"),
    conclusion: ciConclusionEnum("conclusion"),
  },
  (t) => [index("ci_jobs_ci_run_id_idx").on(t.ciRunId)],
);

// ---------------------------------------------------------------------------
// service -- owns a set of path patterns within a repo, e.g. "src/payments/**"
// ---------------------------------------------------------------------------
export const services = pgTable(
  "services",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    pathPatterns: text("path_patterns").array().notNull().default([]),
  },
  (t) => [uniqueIndex("services_repo_name_idx").on(t.repoId, t.name)],
);

// ---------------------------------------------------------------------------
// deployment (+ its steps)
// ---------------------------------------------------------------------------
export const deployments = pgTable(
  "deployments",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(), // idempotency key for webhook dedup
    fromSha: text("from_sha"),
    toSha: text("to_sha").notNull(),
    status: deploymentStatusEnum("status").notNull().default("succeeded"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("deployments_service_external_id_idx").on(t.serviceId, t.externalId),
    index("deployments_started_at_idx").on(t.startedAt),
  ],
);

export const deploymentSteps = pgTable(
  "deployment_steps",
  {
    id: serial("id").primaryKey(),
    deploymentId: integer("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("succeeded"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("deployment_steps_deployment_id_idx").on(t.deploymentId)],
);

// ---------------------------------------------------------------------------
// health event
// ---------------------------------------------------------------------------
export const healthEvents = pgTable(
  "health_events",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(), // idempotency key for webhook dedup
    status: healthStatusEnum("status").notNull(),
    metricName: text("metric_name"),
    metricValue: real("metric_value"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    source: text("source").notNull().default("manual"),
  },
  (t) => [
    uniqueIndex("health_events_service_external_id_idx").on(t.serviceId, t.externalId),
    index("health_events_observed_at_idx").on(t.observedAt),
  ],
);

// ---------------------------------------------------------------------------
// incident
// ---------------------------------------------------------------------------
export const incidents = pgTable(
  "incidents",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    firstUnhealthyEventId: integer("first_unhealthy_event_id").references(() => healthEvents.id),
    status: incidentStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("incidents_service_opened_at_idx").on(t.serviceId, t.openedAt)],
);

// ---------------------------------------------------------------------------
// correlation result -- one row per ranked candidate for an incident
// ---------------------------------------------------------------------------
export const correlationResults = pgTable(
  "correlation_results",
  {
    id: serial("id").primaryKey(),
    incidentId: integer("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    candidateType: candidateTypeEnum("candidate_type").notNull(),
    candidateRef: text("candidate_ref").notNull(), // commit sha, or PR number as text
    score: real("score").notNull(),
    scoreBreakdown: jsonb("score_breakdown").notNull(), // { timeProximity, fileOverlap, ciSignal, prRisk, partialData }
    rank: integer("rank").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("correlation_results_incident_id_idx").on(t.incidentId, t.rank)],
);

// ---------------------------------------------------------------------------
// ingestion checkpoint -- lets the worker resume instead of re-scanning
// ---------------------------------------------------------------------------
export const ingestionCheckpoints = pgTable(
  "ingestion_checkpoints",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // github_commits | github_prs | github_ci
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    cursor: text("cursor"), // opaque: ISO timestamp, page token, etc.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ingestion_checkpoints_source_repo_idx").on(t.source, t.repoId)],
);

// ---------------------------------------------------------------------------
// benchmark ground truth -- ONLY written by scripts/seed-synthetic.ts and
// scripts/benchmark.ts, and only read by scripts/benchmark.ts. Kept out of
// the domain tables above so the schema itself never contains anything
// dressed up as real incident data.
// ---------------------------------------------------------------------------
export const benchmarkGroundTruth = pgTable("benchmark_ground_truth", {
  id: serial("id").primaryKey(),
  incidentId: integer("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  causativeCommitSha: text("causative_commit_sha").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// relations (used by db.query.* for readable joined fetches)
// ---------------------------------------------------------------------------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
  commits: many(commits),
  pullRequests: many(pullRequests),
  ciRuns: many(ciRuns),
  services: many(services),
}));

export const commitsRelations = relations(commits, ({ one, many }) => ({
  repository: one(repositories, { fields: [commits.repoId], references: [repositories.id] }),
  files: many(commitFiles),
}));

export const commitFilesRelations = relations(commitFiles, ({ one }) => ({
  commit: one(commits, { fields: [commitFiles.commitId], references: [commits.id] }),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one, many }) => ({
  repository: one(repositories, { fields: [pullRequests.repoId], references: [repositories.id] }),
  ciRuns: many(ciRuns),
}));

export const ciRunsRelations = relations(ciRuns, ({ one, many }) => ({
  repository: one(repositories, { fields: [ciRuns.repoId], references: [repositories.id] }),
  pullRequest: one(pullRequests, { fields: [ciRuns.pullRequestId], references: [pullRequests.id] }),
  jobs: many(ciJobs),
}));

export const ciJobsRelations = relations(ciJobs, ({ one }) => ({
  ciRun: one(ciRuns, { fields: [ciJobs.ciRunId], references: [ciRuns.id] }),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  repository: one(repositories, { fields: [services.repoId], references: [repositories.id] }),
  deployments: many(deployments),
  healthEvents: many(healthEvents),
  incidents: many(incidents),
}));

export const deploymentsRelations = relations(deployments, ({ one, many }) => ({
  service: one(services, { fields: [deployments.serviceId], references: [services.id] }),
  steps: many(deploymentSteps),
}));

export const deploymentStepsRelations = relations(deploymentSteps, ({ one }) => ({
  deployment: one(deployments, { fields: [deploymentSteps.deploymentId], references: [deployments.id] }),
}));

export const healthEventsRelations = relations(healthEvents, ({ one }) => ({
  service: one(services, { fields: [healthEvents.serviceId], references: [services.id] }),
}));

export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  service: one(services, { fields: [incidents.serviceId], references: [services.id] }),
  firstUnhealthyEvent: one(healthEvents, {
    fields: [incidents.firstUnhealthyEventId],
    references: [healthEvents.id],
  }),
  correlationResults: many(correlationResults),
}));

export const correlationResultsRelations = relations(correlationResults, ({ one }) => ({
  incident: one(incidents, { fields: [correlationResults.incidentId], references: [incidents.id] }),
}));
