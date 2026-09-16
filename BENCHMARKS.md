# Benchmarks

This document describes how CodePulse's benchmark results were collected, what each measurement represents, and the limitations of the benchmark.

The results below were collected by running `npm run benchmark` against a local production build of CodePulse. The benchmark generates its own synthetic incident dataset, runs the same correlation logic used by the application, exercises real HTTP API endpoints, and writes the measured results to `benchmark-results/`.

Automated test counts come from the project's Vitest and Playwright suites.

## How to reproduce

```bash
docker compose up -d db
npm run db:migrate
npm run build && npm start &
npm run benchmark
```

The benchmark expects the application to already be running because the API-latency portion sends real HTTP requests to the local CodePulse server.

If the application cannot be reached, the benchmark exits with an error instead of reporting partial API measurements.

## Benchmark environment

The results below were collected on September 16, 2026 using:

- Next.js production build
- Local PostgreSQL instance running through Docker
- Single-machine execution
- Synthetic dataset generated with RNG seed `42`

Because the benchmark runs locally, latency results can vary depending on CPU load, Docker activity, database state, and other processes running on the machine.

## What the benchmark measures

### 1. Synthetic dataset generation

`scripts/lib/dataset.ts` generates a repeatable dataset representing approximately 10 days of software-development and service-health activity.

The generated dataset contains:

- 6 services
- commits
- pull requests
- CI runs
- deployments
- health-check events
- 200 seeded incident scenarios

Each incident scenario includes a known causative commit.

The generator creates a commit with a known changed-file set, deploys it to a service shortly before that service reports an unhealthy state, and stores the causative commit SHA in a separate `benchmark_ground_truth` table.

The correlation engine does not read this table. It exists only so the benchmark can compare the engine's ranked output against the known seeded cause.

The seed phase writes the generated dataset directly to PostgreSQL and records how long the insert takes.

### 2. Correlation

For each seeded incident, the benchmark calls:

`computeCorrelationForIncident`

This is the same correlation function used by the application worker and incident-correlation API route.

The benchmark records:

- correlation execution time
- whether the known causative commit ranked first
- whether the known causative commit appeared within the first three candidates

This produces two localization metrics:

- **Top-1 accuracy** — the known causative commit is ranked first
- **Top-3 accuracy** — the known causative commit appears anywhere in the first three ranked candidates

### 3. API latency

The benchmark sends **300 total requests with a maximum concurrency of 20** against each of the following endpoints:

```text
GET /api/incidents/[id]
GET /api/timeline/[repoId]
```

Incident requests rotate across 20 real incident IDs from the seeded dataset.

Each request is timed client-side using `performance.now()`.

The samples are sorted and used to calculate:

- p50 latency
- p95 latency

No external histogram library is used to calculate these values.

## Results

Results from the September 16, 2026 benchmark run:

| Metric | Result |
|---|---:|
| Core events generated | **31,197** |
| Synthetic dataset insertion throughput | **~22,600 events/sec** |
| Correlation duration | p50 **12.7 ms**, p95 **17.6 ms** |
| Localization accuracy, top-1 | **87.5%** (175/200) |
| Localization accuracy, top-3 | **94.5%** (189/200) |
| `GET /api/incidents/[id]` latency | p50 **37.7 ms**, p95 **45.6 ms** |
| `GET /api/timeline/[repoId]` latency | p50 **83.9 ms**, p95 **111.6 ms** |
| Automated tests | **81** (78 Vitest + 3 Playwright) |

## Reading the localization results

CodePulse produces a ranked list of candidate changes rather than a single definitive root-cause verdict.

Across 200 seeded incident scenarios, the known causative commit ranked first in 175 cases, producing **87.5% top-1 localization accuracy**.

The correct commit appeared within the first three ranked candidates in 189 cases, producing **94.5% top-3 localization accuracy**.

Both values are reported because they represent different behavior.

Top-1 accuracy measures how often the engine ranked the exact seeded cause as its highest-confidence candidate.

Top-3 accuracy measures how often the engine reduced the investigation to a short list containing the known cause.

This matches the application's incident workflow, where engineers inspect a ranked candidate list rather than receiving a single automated verdict.

## Why the API endpoints have different latency

The two measured endpoints perform different amounts of work.

### Incident detail

`GET /api/incidents/[id]`

The incident-detail path primarily performs indexed lookups for a specific incident and its related data.

Its measured latency was:

```text
p50 37.7 ms
p95 45.6 ms
```

### Repository timeline

`GET /api/timeline/[repoId]`

The timeline path performs more work per request.

It reads from five event sources in parallel using `Promise.all`, then merges and sorts those results in application code before returning the response.

Under concurrent load, this creates more simultaneous database work than the incident-detail path.

Its measured latency was:

```text
p50 83.9 ms
p95 111.6 ms
```

Both endpoints currently read directly from PostgreSQL without an application caching layer.

The tradeoff and possible future caching strategy are discussed in `DESIGN_DECISIONS.md`.

## Repeatability

The synthetic generator uses the fixed RNG seed:

`42`

This means benchmark runs generate the same incident scenarios and ground-truth relationships unless the generator itself changes.

The localization measurements therefore operate on a stable synthetic workload.

Latency measurements are more sensitive to runtime conditions and may vary between runs.

On local reruns, API p95 latency can move depending on factors such as:

- CPU load
- Docker activity
- PostgreSQL state
- background processes
- whether the application is running in development or production mode

The benchmark should therefore be interpreted as a documented local measurement rather than a universal performance guarantee.

## Benchmark assumptions

The synthetic incident generator models a deploy-to-detection delay between approximately 5 and 25 minutes.

That range is an explicit benchmark assumption defined in `scripts/lib/dataset.ts`.

Changing the delay distribution can change how difficult it is for the correlation engine to distinguish the causative change from nearby commits and deployments.

Other synthetic assumptions include:

- known service ownership
- controlled commit histories
- generated CI and deployment relationships
- synthetic health events
- bounded incident windows

These assumptions make the workload reproducible, but they also make it simpler than many real production incident environments.

## What this benchmark does not claim

This benchmark runs on:

- one machine
- one application process
- one local PostgreSQL container
- synthetic data generated by this repository

It is not a distributed load test and does not attempt to model large-scale production infrastructure.

The localization results also should not be interpreted as evidence that the same accuracy would hold on real incident data.

Production incidents may contain:

- incomplete telemetry
- unrelated deployments
- noisy health signals
- missing commit ancestry
- delayed observations
- overlapping failures
- multiple simultaneous causes

The benchmark instead provides a controlled way to evaluate the behavior of the current correlation algorithm against a known workload.

The seeded ground truth is intentionally isolated from the correlation engine so the ranking logic must infer candidate causes from the generated commit, deployment, CI, and health signals.

## Benchmark output

Running:

```bash
npm run benchmark
```

prints a summary to the terminal and writes a machine-readable JSON report to:

```text
benchmark-results/
```

That directory is ignored by Git so local benchmark runs do not create unnecessary repository changes.

To compare performance across machines or future implementations, run the same benchmark and compare the generated reports under equivalent runtime conditions.
