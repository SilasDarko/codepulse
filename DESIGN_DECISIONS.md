# Design Decisions

Each section is one choice, the alternative considered, and why this one won. The common thread: pick the option that's easier to explain and to verify, unless there's a concrete reason at this project's actual scale to do otherwise.

## Drizzle, not Prisma

Both were allowed. Drizzle's query builder is a thin layer over SQL you write yourself (`db.select().from(commits).where(eq(commits.repoId, id))`) -- there's no generated client, no separate schema DSL that compiles to something else. Prisma is a fine tool, but its codegen step means a meaningful amount of what runs is code nobody in the room wrote. For a project whose whole point is "I can explain every line," that tradeoff went to Drizzle.

## No Redis

The spec allowed it "only if justified." At this project's scale -- a handful of open incidents, tens of thousands of ingested rows -- a `jobs`-shaped Postgres table plus a worker that polls it (`src/worker/poll-cycle.ts`) does the job with one fewer moving part to run, explain, and fail. Redis would earn its place if: (a) ingestion needed sub-second job pickup latency the poll interval can't give, (b) multiple worker instances needed to coordinate without double-processing (a real queue's visibility timeout beats a hand-rolled lock), or (c) something needed pub/sub fan-out to many consumers. None of those are true here.

## Deterministic scoring, not an LLM

The spec asked for this explicitly, but it's worth stating why it's the right call independent of that: the correlation engine's whole value is that its answer is auditable -- every score decomposes into four named numbers (`src/correlation/score.ts`), and the same input always produces the same output. An LLM call would trade that for something that's harder to test (`tests/unit/correlation/score.test.ts` runs in milliseconds with zero API calls), harder to reproduce (temperature, model versions, rate limits), and no more accurate at this specific task -- ranking candidates by a handful of well-understood signals is a scoring problem, not a language problem. Nothing stops a later version from summarizing the evidence *after* the deterministic ranking runs -- that's explicitly still an option per the spec -- but the ranking itself stays a function you can hand-trace.

## A polling worker, not a queue framework

`src/worker/index.ts` is a `for (;;) { await runPollCycle(...); await sleep(...) }` loop. No BullMQ, no pg-boss, no cron library. The two things it does -- pull new GitHub data, recompute correlation for open incidents -- are both idempotent and cheap to just redo on a timer; there's no work here that needs at-least-once delivery guarantees a real queue provides. `WORKER_POLL_INTERVAL_MS` is the whole scheduling story.

## Idempotency via upsert, not a dedup table

Deployment and health-event webhooks are deduplicated with a unique constraint on `(serviceId, externalId)` plus `onConflictDoUpdate` (see `src/ingestion/deployment-ingest.ts`, `src/ingestion/health-ingest.ts`). GitHub-ingested rows (commits, PRs, CI runs) are deduplicated the same way on `(repoId, sha|number|externalId)`. This means "duplicate ingestion" isn't a special case the code has to detect and branch on -- it's just what an upsert does. The tradeoff: a legitimate *update* (e.g. a deployment's status changing from `in_progress` to `succeeded`) and a *duplicate* look identical to the database. `ingestDeployment`/`ingestHealthEvent` return a `duplicate` flag computed by checking for the row's existence before the upsert, specifically so callers (and tests) can tell the two apart when it matters.

## Incidents keyed on observed time, not arrival order

`src/ingestion/health-ingest.ts` opens/extends/resolves an incident by comparing the incoming event's `observedAt` against what's already stored -- never by "this event just arrived, so it must be latest." A health-check event that arrives late (network retry, backpressure, whatever) but observed the outage *earlier* than what's on file correctly moves the incident's `openedAt` backward; a late-arriving "healthy" reading between two "down" readings correctly does *not* resolve the incident. `tests/integration/health-ingest.test.ts` has both cases.

## One repo, one database, ancestry resolved on demand

`src/correlation/ancestry.ts` walks parent pointers at correlation time rather than materializing a full commit graph up front. For the incident-scale this project targets (a handful of commits between deployments, not thousands), that's cheap enough to not need caching, and it means "a commit's parent was never ingested" surfaces naturally as `complete: false` instead of requiring a separate consistency-checking pass.

## A commit "belongs to" a PR only via its head SHA

`src/correlation/load.ts` associates a commit with a pull request when `commit.sha === pr.headSha` -- not by resolving the PR's full base..head commit range. This means an intermediate commit on a long-lived PR branch is scored as a plain commit with no PR-level CI/size signal attached. That's a real simplification, not an oversight: resolving true PR membership would mean re-running the same ancestry walk used for deployments, a second time, for every PR, which is more complexity than this project's synthetic and small-repo-scale real data need. If PR-spanning-many-commits accuracy mattered, this is the first thing to change.

## Per-process Prometheus endpoints, not a shared registry

The app (`GET /api/metrics`) and the worker (`:9091/metrics`, `src/worker/metrics-server.ts`) each expose their own `prom-client` registry because they're separate OS processes with separate memory -- there's no way for the app to report the worker's `worker_lag_seconds` without the worker writing it somewhere shared, and building that (Redis, a metrics-push gateway, shared memory) is more infrastructure than a two-process project needs. Prometheus already solves this: scrape both targets, and both processes' metrics show up under the same `job` label family in the same TSDB. `prometheus.yml` configures both.

## No caching layer

Every read (timeline, incident detail, dashboard) goes straight to Postgres. `BENCHMARKS.md` shows the measured cost of that: the incident-detail path is fast enough (p95 ~46ms) that caching would be solving a problem that doesn't exist yet; the timeline path is slower (p95 ~112ms) because it fans out to 5 tables per request. If that endpoint needed to be faster, the first move would be collapsing those 5 queries into fewer round trips (a single query with UNIONs, or precomputing the merged feed on write) -- not reaching for Redis, which would add a cache-invalidation problem in exchange for solving a query-shape problem.

## Integer primary keys, not UUIDs

Every table uses a `serial` primary key. UUIDs would avoid ever leaking row counts and would let IDs be generated client-side -- neither matters here, and integers are shorter to read in logs, test assertions, and URLs (`/incidents/42` beats `/incidents/f47ac10b-58cc-...`).

## Why the timeline and incident-detail pages share their query function with the API routes

`src/lib/timeline.ts` and `src/lib/incident-detail.ts` are imported by both a page (server component) and the equivalent API route. The alternative -- have the page `fetch()` its own API route -- would mean an extra HTTP round trip for data the server already has direct database access to, for no benefit (nothing about the API route's behavior needs to be re-validated by the page that's running in the same process).
