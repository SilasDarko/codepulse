// One process-wide prom-client registry, imported by API routes, the
// worker, and the ingestion adapters. Deliberately a flat list of metrics
// (no wrapper abstraction) -- each one maps directly to an item in the
// project's PROMETHEUS METRICS requirement, so `GET /api/metrics` output
// can be read next to that list line for line.
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** ingestion events/sec (rate() this in PromQL) */
export const ingestionEventsTotal = new Counter({
  name: "codepulse_ingestion_events_total",
  help: "Rows successfully ingested, by source and entity type",
  labelNames: ["source", "entity"] as const,
  registers: [registry],
});

/** ingestion errors */
export const ingestionErrorsTotal = new Counter({
  name: "codepulse_ingestion_errors_total",
  help: "Ingestion failures, by source and reason",
  labelNames: ["source", "reason"] as const,
  registers: [registry],
});

/** worker lag */
export const workerLagSeconds = new Gauge({
  name: "codepulse_worker_lag_seconds",
  help: "Seconds since the worker last completed a full poll cycle",
  registers: [registry],
});

/** correlation duration */
export const correlationDurationSeconds = new Histogram({
  name: "codepulse_correlation_duration_seconds",
  help: "Wall-clock time to compute and persist ranked candidates for one incident",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

/** API request latency */
export const apiRequestDurationSeconds = new Histogram({
  name: "codepulse_api_request_duration_seconds",
  help: "API route handler latency",
  labelNames: ["route", "method", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  registers: [registry],
});

/** GitHub rate-limit remaining */
export const githubRateLimitRemaining = new Gauge({
  name: "codepulse_github_rate_limit_remaining",
  help: "Remaining GitHub API rate-limit quota, from the most recent response's x-ratelimit-remaining header",
  registers: [registry],
});

/** worker failures */
export const workerFailuresTotal = new Counter({
  name: "codepulse_worker_failures_total",
  help: "Worker poll cycles that threw before completing",
  labelNames: ["stage"] as const,
  registers: [registry],
});
