import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/src/db/client";
import { commits } from "@/src/db/schema";
import { seedSyntheticDataset } from "../../scripts/lib/dataset";
import { computeCorrelationForIncident } from "@/src/correlation/compute";
import { closeDb } from "../helpers/db";

afterAll(closeDb);

// A small-scale smoke test for the generator scripts/benchmark.ts and
// `npm run seed` both depend on: it runs the real generator (truncating the
// test database, same as every other integration test) at a size chosen for
// test-suite speed, not for representative accuracy numbers -- those come
// from the full-scale `npm run benchmark`, not from this assertion. What
// this guards is that the generator and the correlation engine keep working
// together: ground truth commits exist, and ranking finds at least most of
// them, so a change that silently breaks either doesn't slip through.
describe("synthetic dataset generator", () => {
  it("produces internally consistent data and a reasonable top-3 hit rate at small scale", async () => {
    const result = await seedSyntheticDataset(db, {
      days: 3,
      incidentScenarios: 20,
      routineCommitsPerServicePerDay: 2,
      routineDeploymentsPerServicePerDay: 2,
      backgroundCommits: 30,
      healthIntervalMinutes: 10,
    });

    expect(result.groundTruth).toHaveLength(20);
    expect(result.totalCoreEvents).toBeGreaterThan(0);

    let top3Hits = 0;
    for (const truth of result.groundTruth) {
      const [causativeCommit] = await db.select().from(commits).where(eq(commits.sha, truth.causativeCommitSha));
      expect(causativeCommit).toBeDefined();

      const ranked = await computeCorrelationForIncident(db, truth.incidentId);
      const top3 = ranked.slice(0, 3);
      if (top3.some((r) => r.candidateType === "commit" && r.candidateRef === truth.causativeCommitSha)) {
        top3Hits++;
      }
    }

    // Small n and a short lookback make this noisier than the full-scale
    // benchmark; a generous floor here just catches a broken generator or a
    // broken scorer, not a below-target accuracy run.
    expect(top3Hits / result.groundTruth.length).toBeGreaterThanOrEqual(0.5);
  });
});
