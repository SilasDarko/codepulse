import { eq } from "drizzle-orm";
import type { Database } from "@/src/db/client";
import { correlationResults } from "@/src/db/schema";
import { loadScoringInputForIncident } from "./load";
import { rankCandidates } from "./rank";
import type { RankedCandidate, ScoringWeights } from "./types";
import { correlationDurationSeconds } from "@/src/metrics/registry";

/**
 * The end-to-end path from "an incident exists" to "ranked candidates are
 * persisted": load -> rank (pure) -> replace this incident's stored
 * results in one transaction. Re-running is always safe -- old results for
 * the incident are cleared first, so this can be called again after more
 * data is ingested without leaving stale rows behind.
 */
export async function computeCorrelationForIncident(
  db: Database,
  incidentId: number,
  weights?: ScoringWeights,
): Promise<RankedCandidate[]> {
  const stopTimer = correlationDurationSeconds.startTimer();
  try {
    const scoringInput = await loadScoringInputForIncident(db, incidentId);
    if (!scoringInput) {
      throw new Error(`Incident ${incidentId} not found`);
    }

    const ranked = rankCandidates(scoringInput, weights);

    await db.transaction(async (tx) => {
      await tx.delete(correlationResults).where(eq(correlationResults.incidentId, incidentId));
      if (ranked.length > 0) {
        await tx.insert(correlationResults).values(
          ranked.map((r, i) => ({
            incidentId,
            candidateType: r.candidateType,
            candidateRef: r.candidateRef,
            score: r.score,
            scoreBreakdown: r.breakdown,
            rank: i + 1,
          })),
        );
      }
    });

    return ranked;
  } finally {
    stopTimer();
  }
}
