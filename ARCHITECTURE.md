# Architecture

## What this is

CodePulse correlates five signals around a software release — commits, pull requests, CI runs, deployments, and service health — to help narrow an incident to the recent changes most likely associated with it.

The ranking is deterministic rather than model-based. Each candidate receives an inspectable score derived from timing, service ownership, CI state, and pull-request context.

## Processes

```text
                                   ┌────────────────────┐
   GitHub REST API  ───poll──────▶ │   worker process   │
                                   │   (src/worker)      │
                                   └────────────────────┘
                                              │
                                              │ writes
                                              ▼
   curl / deploy tool /            ┌────────────────────┐
   monitoring webhook ──POST──────▶│    Next.js app     │
                                   │  route handlers     │
   browser ─────GET/navigate──────▶│    + pages          │
                                   └────────────────────┘
                                              │
                                              │ reads/writes
                                              ▼
                                   ┌────────────────────┐
                                   │     PostgreSQL      │
                                   └────────────────────┘

   Prometheus ──scrape──▶ GET /api/metrics
                         :9091/metrics
```

CodePulse runs as two Node.js processes backed by one PostgreSQL database.

- **The Next.js app** (`npm run dev` / `npm start`) serves the UI and the API routes under `app/api/*`. Route handlers validate input with Zod, call application logic in `src/`, and return JSON responses.
- **The worker** (`npm run worker`) runs a polling loop that fetches new commits, pull requests, and CI runs from GitHub, advances ingestion checkpoints, and recomputes ranked candidates for open incidents.

Both processes use the same PostgreSQL database and import the same application modules. The difference is how work is triggered: HTTP requests for the Next.js app and scheduled polling for the worker.

There is no message queue in the current architecture. The reasoning and tradeoffs behind that choice are documented in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Data model

The schema stores the five core release signals along with the supporting state required for resumable ingestion, incident tracking, and inspectable correlation results.

| Table | Purpose |
|---|---|
| `repositories` | A tracked GitHub repository |
| `commits` | Commit metadata ingested from GitHub |
| `commit_files` | Files modified by each commit |
| `pull_requests` | Pull-request metadata associated with the repository |
| `ci_runs` | CI workflow runs |
| `ci_jobs` | Individual jobs associated with CI runs |
| `services` | Logical services and the repository path patterns they own |
| `deployments` | Deployments of commits to services |
| `deployment_steps` | Individual steps associated with a deployment |
| `health_events` | Health observations for services over time |
| `incidents` | Service incidents created from unhealthy observations |
| `correlation_results` | Ranked candidate changes and their score breakdowns |
| `ingestion_checkpoints` | Per-source ingestion cursors used by the worker |

Incidents are based on the health event's **observed timestamp**, rather than insertion order. This allows the ingestion layer to handle delayed or out-of-order health events correctly.

The implementation is in `src/ingestion/health-ingest.ts`.

### Benchmark ground truth

The benchmark uses an additional table:

`benchmark_ground_truth`

This table is intentionally isolated from the production correlation path.

It is:

- written by `scripts/lib/dataset.ts`
- read by `scripts/benchmark.ts`
- never queried by the correlation engine

Its only purpose is to record the known causative commit for each synthetic incident so benchmark output can be compared against a hidden reference value.

The complete schema, indexes, and constraints are defined in `src/db/schema.ts`.

## Correlation engine

The scoring core is implemented as pure, I/O-free functions across four focused modules.

### `src/correlation/types.ts`

Defines the plain-data structures used by the ranking engine, including:

- commit candidates
- deployment context
- CI signals
- pull-request metadata
- service ownership information
- scoring inputs
- ranked outputs

These types are deliberately separate from the database schema so the correlation logic can operate without depending on PostgreSQL-specific objects.

### `src/correlation/ancestry.ts`

`resolveCommitRange` walks backward through the commit graph from a deployment's `toSha` toward its `fromSha`.

The function follows parent relationships and reports whether the traversal is complete.

If part of the commit ancestry is missing, the engine records that condition rather than silently treating an incomplete graph as a complete one.

This behavior is covered by the missing-ancestry failure tests.

### `src/correlation/score.ts`

Scores one candidate commit against the incident and deployment context.

The score is built from four independent components:

1. **Time proximity** — how close the candidate change is to the deployment and incident window
2. **Service ownership overlap** — whether the files modified by the commit overlap with the service's owned paths
3. **CI signal** — the state of CI associated with the candidate change
4. **Pull-request risk** — contextual information from the related pull request

Each component is calculated independently and then combined through a weighted scoring function.

Keeping the components separate makes individual scoring behavior directly testable.

### `src/correlation/rank.ts`

`rankCandidates` evaluates all candidate commits considered for an incident and returns them in score order.

These modules perform no database or network I/O, which keeps the ranking logic independently testable with plain JavaScript and TypeScript objects.

Unit tests for the scoring core live under:

```text
tests/unit/correlation/
```

## Database-backed correlation

The database-facing portion of the correlation flow sits one layer above the scoring core.

### `src/correlation/load.ts`

Loads the data required to build a `ScoringInput`.

This includes:

- the incident
- affected service
- relevant deployments
- commit history
- changed files
- CI state
- pull-request context
- commit ancestry

This is the primary correlation module that reads from PostgreSQL.

### `src/correlation/compute.ts`

`computeCorrelationForIncident` coordinates the complete correlation flow:

```text
load incident context
        ↓
rank candidates
        ↓
persist correlation results
```

The stored result includes the ranked candidates and the score breakdown used to produce each ranking.

The write is performed transactionally so an incident does not end up with a partially replaced result set.

Both the API and the worker call this same function, which keeps the ranking behavior consistent regardless of how the computation was triggered.

## Ingestion

CodePulse supports two main ingestion paths.

### GitHub polling

The worker polls the GitHub REST API for:

- commits
- pull requests
- CI runs

Relevant modules include:

```text
src/ingestion/github-client.ts
src/ingestion/github-adapter.ts
src/ingestion/github-types.ts
src/ingestion/checkpoint.ts
```

The worker records ingestion checkpoints so it can resume from the most recently processed position after a restart.

### Deployment and health ingestion

Deployments and service-health observations can be submitted through HTTP endpoints:

```text
POST /api/deployments
POST /api/health-events
```

Both paths validate request payloads with Zod before writing to the database.

The ingestion logic uses caller-provided external identifiers to make repeated events idempotent. Duplicate deliveries update the existing record rather than creating multiple copies of the same logical event.

Relevant modules:

```text
src/ingestion/deployment-ingest.ts
src/ingestion/health-ingest.ts
```

## Request paths

### `POST /api/deployments`

Accepts deployment events and persists them through the deployment ingestion layer.

The endpoint validates the request before database access and supports idempotent updates using the supplied external identifier.

### `POST /api/health-events`

Accepts service-health observations.

An unhealthy health event can create or update an incident for the affected service.

Incident timing is based on the observation timestamp carried by the event rather than the order in which events arrive.

### `GET /api/timeline/[repoId]`

Returns a chronological release timeline for a repository.

The timeline merges:

- commits
- pull requests
- CI runs
- deployments
- health events

The query implementation lives in:

```text
src/lib/timeline.ts
```

The current implementation reads the event sources in parallel with `Promise.all`, then merges and sorts the results in application code.

### `GET /api/incidents/[id]`

Returns an incident and its stored ranked correlation results.

The query implementation is shared with the server-rendered incident page through:

```text
src/lib/incident-detail.ts
```

### `POST /api/incidents/[id]/correlate`

Forces the application to recompute correlation results for an incident.

The route calls the same `computeCorrelationForIncident` function used by the background worker.

### `GET /api/metrics`

Exposes Prometheus metrics for the Next.js process.

Because the app and worker are separate OS processes, each maintains its own in-memory `prom-client` registry.

The worker therefore exposes a separate metrics endpoint:

```text
:9091/metrics
```

The worker metrics server is implemented in:

```text
src/worker/metrics-server.ts
```

Keeping the two registries separate avoids introducing an additional aggregation service solely for sharing in-memory process metrics.

## Worker flow

The worker performs repeated polling cycles.

A simplified cycle looks like:

```text
load ingestion checkpoint
        ↓
poll GitHub
        ↓
ingest commits / PRs / CI runs
        ↓
update checkpoint
        ↓
load open incidents
        ↓
recompute correlation rankings
        ↓
record worker metrics
```

The orchestration logic lives in:

```text
src/worker/poll-cycle.ts
```

and the long-running worker entry point is:

```text
src/worker/index.ts
```

Failure handling is designed so one failed repository operation or incident computation does not terminate the entire worker process.

The failure behavior is covered by tests under:

```text
tests/failure/
```

## UI

CodePulse currently exposes three server-rendered pages.

### Dashboard

```text
/
```

Shows the high-level state of tracked repositories and active incidents.

### Repository timeline

```text
/repos/[id]
```

Displays the release timeline for a repository, combining changes, CI activity, deployments, and health observations.

### Incident detail

```text
/incidents/[id]
```

Displays the ranked candidate changes associated with an incident and the evidence used by the correlation engine.

The UI does not currently use a client-side state-management library.

Where possible, server-rendered pages and API routes share the same query functions. For example:

```text
src/lib/timeline.ts
src/lib/incident-detail.ts
```

This keeps each concept on one database query path instead of maintaining separate implementations for the UI and API.

## Observability

CodePulse uses Prometheus-compatible metrics to expose internal behavior from both runtime processes.

Metrics cover areas such as:

- ingestion activity
- ingestion failures
- worker lag
- correlation execution
- API latency
- GitHub rate-limit behavior
- worker failures

The shared application metrics definitions live in:

```text
src/metrics/registry.ts
```

Prometheus configuration is provided in:

```text
prometheus.yml
```

## Testing boundaries

The project separates tests by responsibility.

```text
tests/unit/
tests/integration/
tests/failure/
tests/benchmark/
tests/e2e/
```

### Unit tests

Exercise pure correlation logic such as:

- commit ancestry
- scoring
- ranking

### Integration tests

Exercise database-backed behavior and API routes, including:

- GitHub ingestion
- deployment ingestion
- health-event ingestion
- checkpoints
- route behavior

### Failure-path tests

Cover behavior such as:

- missing commit ancestry
- GitHub rate limiting
- malformed deployment events
- partial CI data
- database rollback
- worker restart
- worker failure isolation

### Benchmark tests

Validate assumptions used by the synthetic benchmark dataset and benchmark harness.

### End-to-end tests

Use Playwright to exercise the release-debugging flow through the running application.

## Design boundary

CodePulse is intentionally built around a deterministic correlation engine.

The system does not claim to prove the root cause of an incident. It ranks recent changes using explicit release signals and presents the resulting evidence for investigation.

That boundary is reflected throughout the architecture:

- scoring inputs are inspectable
- ranking behavior is deterministic
- score components are independently testable
- benchmark ground truth is isolated from the engine
- incomplete data is surfaced rather than silently treated as complete
- ranked candidates are presented instead of a single automated verdict

Additional tradeoffs and possible future changes are documented in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).
Three server-rendered pages, no client-side state library: `/` (dashboard), `/repos/[id]` (timeline), `/incidents/[id]` (ranked evidence). Each page's data-fetching function is shared with the equivalent API route (`src/lib/timeline.ts`, `src/lib/incident-detail.ts`) so there's exactly one query path per concept, not two that can drift apart.
