# CodePulse

CodePulse is a release-debugging tool that brings commits, pull requests, CI runs, deployments, and service-health events into one timeline and uses those signals to rank recent changes associated with an incident.

When a service becomes unhealthy, CodePulse evaluates recent candidate commits using a deterministic scoring function based on timing, service ownership, CI state, and pull-request context. The result is an inspectable ranked list rather than a single automated root-cause verdict.

For more detail:

- [ARCHITECTURE.md](ARCHITECTURE.md) — system structure and data flow
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) — design tradeoffs and implementation choices
- [BENCHMARKS.md](BENCHMARKS.md) — benchmark methodology and measured results

## Stack

- **Frontend / API:** Next.js App Router, TypeScript
- **Database:** PostgreSQL, Drizzle ORM
- **Background processing:** Node.js worker
- **GitHub ingestion:** `@octokit/rest`
- **Validation:** Zod
- **Metrics:** Prometheus, `prom-client`
- **Testing:** Vitest, Playwright
- **Local infrastructure:** Docker Compose

The current architecture intentionally does not use a message-queue framework. The worker polls external sources and operates against the same PostgreSQL database used by the application.

## Setup

### Requirements

- Node.js 20+
- Docker
- npm
- Optional GitHub personal access token for live GitHub ingestion

Clone the repository:

```bash
git clone https://github.com/SilasDarko/codepulse.git
cd codepulse
```

Create your local environment file:

```bash
cp .env.example .env
```

Install dependencies:

```bash
npm install
```

Start PostgreSQL:

```bash
docker compose up -d db
```

Run the application database migration:

```bash
npm run db:migrate
```

Run the separate test-database migration:

```bash
npm run db:migrate:test
```

You can also run the complete setup process with:

```bash
make setup
```

## Running CodePulse

Start the application:

```bash
npm run dev
```

The application will be available at:

```text
http://localhost:3000
```

Start the background worker in a second terminal:

```bash
npm run worker
```

The worker polls GitHub for commits, pull requests, and CI runs and recomputes correlation results for open incidents.

### GitHub ingestion

Live GitHub ingestion requires the following values in `.env`:

```text
GITHUB_TOKEN=
GITHUB_REPO=owner/repository
```

If they are not configured, the worker can still run. GitHub polling is skipped, while the rest of the system can operate on data submitted through the ingestion APIs or generated locally.

## Run it with synthetic data

CodePulse includes a deterministic synthetic dataset generator so the application can be explored without connecting a real GitHub repository.

Run:

```bash
npm run seed
```

The seed script resets the development dataset and generates release activity containing:

- commits
- pull requests
- CI runs
- deployments
- service-health events
- seeded incidents

The generated data is synthetic and is written only to the configured local development database.

After seeding, open:

```text
http://localhost:3000
```

The dashboard displays incidents that can be opened to inspect ranked candidate changes and their score breakdowns.

See [BENCHMARKS.md](BENCHMARKS.md) for details about how the synthetic dataset is generated and used for evaluation.

## Ingestion APIs

CodePulse can also be driven directly through its HTTP API.

### Register a repository

```bash
curl -X POST http://localhost:3000/api/repos \
  -H 'Content-Type: application/json' \
  -d '{
    "owner": "octo",
    "name": "widgets"
  }'
```

### Register a service

A service owns a set of file-path patterns within a repository.

```bash
curl -X POST http://localhost:3000/api/services \
  -H 'Content-Type: application/json' \
  -d '{
    "repoId": 1,
    "name": "web",
    "pathPatterns": ["src/**"]
  }'
```

### Report a deployment

```bash
curl -X POST http://localhost:3000/api/deployments \
  -H 'Content-Type: application/json' \
  -d '{
    "serviceId": 1,
    "externalId": "d1",
    "toSha": "abc123",
    "status": "succeeded",
    "startedAt": "2026-01-01T11:55:00Z",
    "completedAt": "2026-01-01T11:56:00Z"
  }'
```

### Report an unhealthy service

```bash
curl -X POST http://localhost:3000/api/health-events \
  -H 'Content-Type: application/json' \
  -d '{
    "serviceId": 1,
    "externalId": "h1",
    "status": "down",
    "observedAt": "2026-01-01T12:00:00Z"
  }'
```

An unhealthy event can create an incident for that service.

### Run correlation

```bash
curl -X POST http://localhost:3000/api/incidents/1/correlate
```

Then open:

```text
http://localhost:3000/incidents/1
```

## Features

### GitHub ingestion

`src/ingestion/github-adapter.ts`

Ingests:

- commits
- pull requests
- CI runs
- CI jobs

Ingestion can resume from persisted checkpoints stored in PostgreSQL.

The GitHub client also exposes rate-limit state to the worker and metrics layer.

### Deployment ingestion

```text
POST /api/deployments
```

Accepts deployment events through an HTTP interface.

Requests are:

- validated with Zod
- idempotent on caller-provided external IDs
- persisted to PostgreSQL

### Service-health ingestion

```text
POST /api/health-events
```

Stores health observations for services.

Incident timing is based on the event's observation time rather than its insertion order, allowing delayed and out-of-order events to be processed consistently.

### Release timeline

```text
GET /api/timeline/[repoId]
```

The timeline combines:

- commits
- pull requests
- CI runs
- deployments
- health events

into one chronological view for a repository.

The corresponding UI is available at:

```text
/repos/[id]
```

### Deterministic correlation

The correlation engine lives under:

```text
src/correlation/
```

Candidate commits are evaluated using four primary signals:

1. time proximity
2. overlap between changed files and service-owned paths
3. CI state
4. pull-request context

The engine returns a ranked candidate list with a score breakdown for each result.

There is no LLM in the scoring path.

### Incident drill-down

```text
GET /api/incidents/[id]
```

and:

```text
/incidents/[id]
```

show the incident together with its ranked candidate changes and scoring evidence.

The UI presents the ranked list rather than treating the highest-scoring candidate as a confirmed cause.

### Prometheus metrics

The Next.js application exposes metrics at:

```text
GET /api/metrics
```

The worker exposes its own process metrics at:

```text
:9091/metrics
```

Metrics cover areas including:

- ingestion activity
- ingestion failures
- worker lag
- worker failures
- correlation duration
- API latency
- GitHub rate-limit state

## Correlation flow

At a high level:

```text
service becomes unhealthy
        ↓
incident is created
        ↓
relevant deployments are loaded
        ↓
candidate commits are collected
        ↓
service ownership + CI + PR context are loaded
        ↓
candidate scores are computed
        ↓
candidates are ranked
        ↓
results are stored
        ↓
ranked evidence appears in the incident view
```

The main orchestration function is:

```text
src/correlation/compute.ts
```

The pure scoring logic is separated from database access so it can be tested independently.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a deeper walkthrough.

## Testing

Run the main Vitest suite:

```bash
npm test
```

Run only unit tests:

```bash
npm run test:unit
```

Run integration tests:

```bash
npm run test:integration
```

Run Playwright end-to-end tests:

```bash
npm run test:e2e
```

Run coverage:

```bash
npm run test:coverage
```

The project currently contains **81 automated tests**:

- 78 Vitest tests
- 3 Playwright end-to-end tests

Tests are organized by responsibility:

```text
tests/
├── unit/
├── integration/
├── failure/
├── benchmark/
└── e2e/
```

### Unit tests

Cover pure correlation logic including:

- ancestry traversal
- candidate scoring
- ranking

### Integration tests

Exercise database-backed behavior including:

- GitHub ingestion
- deployment ingestion
- health-event ingestion
- checkpoints
- API routes

### Failure-path tests

Cover scenarios including:

- GitHub rate limiting
- worker restart
- worker failure isolation
- malformed deployment events
- database rollback
- missing commit ancestry
- partial CI data

### Benchmark tests

Validate the synthetic dataset and benchmark assumptions at a smaller scale.

The measured benchmark results are produced by `npm run benchmark`, not hard-coded into the test suite.

### End-to-end tests

Playwright exercises application flows through the running web interface and API.

You can also run:

```bash
make test
make test-e2e
```

## Benchmarking

Build and start the production application:

```bash
npm run build
npm start
```

Then, in another terminal:

```bash
npm run benchmark
```

The benchmark:

- generates more than 31,000 core events
- creates 200 synthetic incident scenarios with known ground truth
- runs the actual correlation engine
- evaluates top-1 and top-3 localization
- measures correlation duration
- exercises real HTTP endpoints
- records p50 and p95 API latency

A measured run on September 16, 2026 produced:

| Metric | Result |
|---|---:|
| Core events generated | **31,197** |
| Correlation duration | p50 **12.7 ms**, p95 **17.6 ms** |
| Top-1 localization | **87.5%** |
| Top-3 localization | **94.5%** |
| Incident API latency | p95 **45.6 ms** |
| Timeline API latency | p95 **111.6 ms** |

The synthetic benchmark is controlled and reproducible, but it is not intended to represent production incident accuracy or distributed infrastructure performance.

See [BENCHMARKS.md](BENCHMARKS.md) for the complete methodology, assumptions, limitations, and reproduction instructions.

## CI

The GitHub Actions workflow is defined in:

```text
.github/workflows/ci.yml
```

It runs on pushes and pull requests and verifies:

```text
lint
  ↓
typecheck
  ↓
tests
  ↓
build
  ↓
end-to-end tests
```

The test job runs against a PostgreSQL service container.

## Repository layout

```text
codepulse/
├── app/
│   ├── api/                     Next.js API routes
│   ├── incidents/               incident drill-down UI
│   └── repos/                   repository timeline UI
│
├── src/
│   ├── correlation/
│   │   ├── types.ts
│   │   ├── ancestry.ts
│   │   ├── score.ts
│   │   ├── rank.ts
│   │   ├── load.ts
│   │   └── compute.ts
│   │
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   └── migrations/
│   │
│   ├── ingestion/
│   │   ├── github-adapter.ts
│   │   ├── github-client.ts
│   │   ├── deployment-ingest.ts
│   │   ├── health-ingest.ts
│   │   └── checkpoint.ts
│   │
│   ├── worker/
│   │   ├── index.ts
│   │   ├── poll-cycle.ts
│   │   └── metrics-server.ts
│   │
│   ├── metrics/
│   │   └── registry.ts
│   │
│   └── lib/
│       ├── timeline.ts
│       ├── incident-detail.ts
│       ├── validation.ts
│       └── http.ts
│
├── scripts/
│   ├── lib/
│   │   └── dataset.ts
│   ├── seed-synthetic.ts
│   ├── benchmark.ts
│   └── migrate.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── failure/
│   ├── benchmark/
│   └── e2e/
│
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── ARCHITECTURE.md
├── BENCHMARKS.md
├── DESIGN_DECISIONS.md
├── docker-compose.yml
├── prometheus.yml
└── Makefile
```

## Environment variables

See `.env.example` for the complete configuration.

The main variables are:

```text
DATABASE_URL
DATABASE_URL_TEST
GITHUB_TOKEN
GITHUB_REPO
WORKER_POLL_INTERVAL_MS
PORT
```

`GITHUB_TOKEN` and `GITHUB_REPO` are optional unless live GitHub ingestion is being used.

## Design philosophy

CodePulse deliberately keeps the correlation process inspectable.

It does not attempt to prove that one change definitively caused an incident. Instead, it combines release signals to narrow the investigation to a ranked set of recent candidates.

The implementation therefore favors:

- explicit scoring rules
- deterministic behavior
- inspectable evidence
- failure-aware ancestry traversal
- idempotent ingestion
- reproducible benchmarks
- separate pure scoring logic and database I/O

For the reasoning behind those choices, see [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).
