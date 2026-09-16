import { resolveCommitRange } from "./ancestry";
import { scoreCommit, weightedTotal, DEFAULT_WEIGHTS } from "./score";
import type { RankedCandidate, ScoringInput, ScoringWeights } from "./types";

/**
 * Deterministically ranks every commit (and, where a commit belongs to a
 * merged PR, that PR) that could plausibly have caused the incident. No
 * network or DB access happens here -- see src/correlation/load.ts for how
 * a real incident gets turned into a ScoringInput.
 */
export function rankCandidates(input: ScoringInput, weights: ScoringWeights = DEFAULT_WEIGHTS): RankedCandidate[] {
  const commitCandidates: RankedCandidate[] = [];
  // number gives a poor sort key for max-per-PR when duplicated across
  // deployments, so track the best (highest-scoring) row seen per PR.
  const bestPerPr = new Map<string, RankedCandidate>();

  for (const deployment of input.deployments) {
    const { commits, complete } = resolveCommitRange(input.commitsBySha, deployment.fromSha, deployment.toSha);
    const deployedAt = deployment.completedAt ?? deployment.startedAt;

    for (const commit of commits) {
      const breakdown = scoreCommit(
        {
          commit,
          deployedAt,
          firstUnhealthyAt: input.firstUnhealthyAt,
          servicePathPatterns: input.servicePathPatterns,
          ancestryComplete: complete,
        },
        weights,
      );
      const score = weightedTotal(breakdown, weights);

      const commitCandidate: RankedCandidate = {
        candidateType: "commit",
        candidateRef: commit.sha,
        deploymentId: deployment.id,
        score,
        breakdown,
      };
      commitCandidates.push(commitCandidate);

      if (commit.pullRequest) {
        const prKey = String(commit.pullRequest.number);
        const existing = bestPerPr.get(prKey);
        if (!existing || score > existing.score) {
          bestPerPr.set(prKey, {
            candidateType: "pull_request",
            candidateRef: prKey,
            deploymentId: deployment.id,
            score,
            breakdown,
          });
        }
      }
    }
  }

  const all = [...commitCandidates, ...bestPerPr.values()];
  all.sort((a, b) => b.score - a.score);
  return all;
}
