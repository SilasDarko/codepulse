# Architecture

## What this is

CodePulse takes five kinds of data about a software release -- commits, pull requests, CI runs, deployments, and service health -- and answers one question: **when a service goes unhealthy, which recent change most likely caused it?** It does that with a deterministic scoring function, not a model, so the answer always comes with a breakdown you can check by hand.

## Processes

```
                                   ┌──────────────────┐
   GitHub REST API  ───poll───▶   │   worker process   │
                                   │  (src/worker)       │──┐
                                   └──────────────────┘  │
                                                            │ writes
   curl / a real deploy   ──POST──▶  ┌────────────────┐    │
   tool / an APM webhook             │  Next.js app    │    │
                                      │  (route handlers │◀──┤ reads
   a browser  ────GET/navigate──▶    │   + pages)       │    │
                                      └────────────────┘    │
                                              │              │
                                              ▼              ▼
                                        ┌─────────────────────┐
                                        │      PostgreSQL       │
                                        └─────────────────────┘

   Prometheus  ──scrape──▶  GET /api/metrics (app)   +   :9091/metrics (worker)
```

Two Node processes, one database, no message queue:

- **The Next.js app** (`npm run dev` / `npm start`) serves the UI (server components, no client-side data-fetching framework) and the API routes under `app/api/*`. Every route is a thin handler: validate input with zod, call one function in `src/`, return JSON.
- **The worker** (`npm run worker`) is a plain loop: poll GitHub for new commits/PRs/CI runs on the tracked repo, then recompute ranked candidates for every open incident. It is not a queue consumer -- there is no job queue. See [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) for why that's enough here.

Both processes talk to the same Postgres database and import the same `src/` code; they just run it on different triggers (an HTTP request vs. a timer).

## Data model

Nine tables carry the five core entities the spec names, plus what's needed to make ingestion resumable and correlation results inspectable:

| Table | What it is |
|---|---|
| `repositories` | A tracked GitHub repo |
| `commits`, `commit_files` | Commit history + the files each commit touched |
| `pull_requests` | PR metadata (a commit "belongs to" a PR when it's that PR's head commit -- see the note in `src/correlation/load.ts`) |
| `ci_runs`, `ci_jobs` | CI runs and their per-job outcomes |
| `services` | A logical service, defined by which file-path patterns it owns within a repo |
| `deployments`, `deployment_steps` | A deployment of one commit to one service |
| `health_events` | A health observation for a service at a point in time |
| `incidents` | Opened when a service's health goes non-healthy; keyed on the *observed* timestamp, not insertion order (see the out-of-order handling in `src/ingestion/health-ingest.ts`) |
| `correlation_results` | The ranked output of the scorer for one incident, with its full score breakdown stored as JSON |
| `ingestion_checkpoints` | One row per (source, repo): the cursor the worker resumes ingestion from |

`benchmark_ground_truth` exists outside this list on purpose: it's written only by `scripts/lib/dataset.ts`, read only by `scripts/benchmark.ts`, and the correlation engine never queries it. See `src/db/schema.ts` for the full column-level definitions and indexes.

## The correlation engine

This is the part of the codebase worth reading end to end; it's about 300 lines across four files, all pure functions with no I/O:

- **`src/correlation/types.ts`** -- the plain-data shapes the engine operates on (`CommitNode`, `ScoringInput`, etc.), deliberately decoupled from the DB schema.
- **`src/correlation/ancestry.ts`** -- `resolveCommitRange` walks a commit graph backward from a deployment's `toSha` to its `fromSha` via parent pointers, and reports whether the walk hit a gap (a commit whose parent was never ingested) instead of silently returning a wrong answer.
- **`src/correlation/score.ts`** -- scores one commit against one deployment on four independent axes (time proximity, changed-file overlap with the service's owned paths, CI signal, PR risk), each a self-contained function you can unit-test in isolation, combined by one small weighted-sum function.
- **`src/correlation/rank.ts`** -- `rankCandidates` runs the scorer over every commit in every deployment considered for an incident and sorts the result. No database, no network -- this is why `tests/unit/correlation/*` can test it with 100% plain object literals.

Everything that *does* need the database lives one layer up:

- **`src/correlation/load.ts`** -- turns one incident's row into a `ScoringInput` by querying Postgres. This is the only file in the correlation package that imports the DB client.
- **`src/correlation/compute.ts`** -- `computeCorrelationForIncident` wires load → rank → persist (replacing the incident's stored results in one transaction) and is what both the API route and the worker call.

## Request paths

- `POST /api/deployments`, `POST /api/health-events` -- webhook-shaped ingestion endpoints. Both are idempotent on an `externalId` the caller supplies (upsert, not insert-or-fail), and both validate with zod before touching the database.
- `GET /api/timeline/[repoId]` -- merges commits/PRs/CI runs/deployments/health events for one repo into one chronological feed (`src/lib/timeline.ts`).
- `GET /api/incidents/[id]`, `POST /api/incidents/[id]/correlate` -- read an incident's ranked evidence, or force a recompute.
- `GET /api/metrics` -- this process's Prometheus metrics. The worker exposes its own separate `:9091/metrics` (see `src/worker/metrics-server.ts`) because it's a different OS process with its own in-memory `prom-client` registry -- there is no way for one process to report another's counters without them writing to something shared, and adding that would be more infrastructure than the project needs (see DESIGN_DECISIONS.md).

## UI

Three server-rendered pages, no client-side state library: `/` (dashboard), `/repos/[id]` (timeline), `/incidents/[id]` (ranked evidence). Each page's data-fetching function is shared with the equivalent API route (`src/lib/timeline.ts`, `src/lib/incident-detail.ts`) so there's exactly one query path per concept, not two that can drift apart.
