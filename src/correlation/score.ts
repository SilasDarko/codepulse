import type { CandidateCiRun, CandidatePullRequest, CommitNode, ScoreBreakdown, ScoringWeights } from "./types";

// Weights are a single, tunable config object rather than being scattered
// through the scoring code -- see DESIGN_DECISIONS.md for how these were
// chosen and scripts/benchmark.ts for how they're validated against
// seeded-incident accuracy.
export const DEFAULT_WEIGHTS: ScoringWeights = {
  timeProximity: 0.4,
  fileOverlap: 0.3,
  ciSignal: 0.2,
  prRisk: 0.1,
};

// Deployments this far before the incident get essentially zero time-proximity
// credit. 45 minutes covers "deploy finished, health checks caught it a few
// minutes later" without also crediting a deploy from three days ago.
const TIME_DECAY_HALF_LIFE_MS = 15 * 60 * 1000;
const TIME_DECAY_CUTOFF_MS = 45 * 60 * 1000;

/** Exponential decay: 1.0 at delta=0, 0.5 at one half-life, ~0 past the cutoff. */
export function timeProximityScore(deployedAt: Date, firstUnhealthyAt: Date): number {
  const deltaMs = firstUnhealthyAt.getTime() - deployedAt.getTime();
  if (deltaMs < 0 || deltaMs > TIME_DECAY_CUTOFF_MS) return 0;
  return Math.pow(0.5, deltaMs / TIME_DECAY_HALF_LIFE_MS);
}

/** Minimal glob matcher: "**" = any path segment count, "*" = one segment, everything else is literal. */
export function pathMatches(filePath: string, pattern: string): boolean {
  const regexSource =
    "^" +
    pattern
      .split("")
      .reduce((acc, ch, i, arr) => {
        if (ch === "*" && arr[i + 1] === "*") return acc; // consume first '*' of '**', handle on second
        if (ch === "*" && arr[i - 1] === "*") return acc + ".*"; // second '*' of '**'
        if (ch === "*") return acc + "[^/]*";
        if (".+?^${}()|[]\\".includes(ch)) return acc + "\\" + ch;
        return acc + ch;
      }, "") +
    "$";
  return new RegExp(regexSource).test(filePath);
}

export function fileOverlapScore(changedFiles: string[], servicePathPatterns: string[]): number {
  if (changedFiles.length === 0 || servicePathPatterns.length === 0) return 0;
  const matched = changedFiles.filter((f) => servicePathPatterns.some((p) => pathMatches(f, p)));
  return matched.length / changedFiles.length;
}

const CI_SIGNAL_NO_DATA = 0.3;
const CI_SIGNAL_SUCCESS = 0.1;
const CI_SIGNAL_SKIPPED_OR_PENDING = 0.5;
const CI_SIGNAL_CANCELLED = 0.7;
const CI_SIGNAL_FAILURE = 1.0;

/** Higher = more suspicious. Missing/partial CI data never throws -- it just falls back to a neutral score. */
export function ciSignalScore(ciRuns: CandidateCiRun[]): { score: number; partialData: boolean } {
  if (ciRuns.length === 0) return { score: CI_SIGNAL_NO_DATA, partialData: true };

  let sawFailure = false;
  let sawPending = false;
  let sawCancelled = false;
  let partialData = false;

  for (const run of ciRuns) {
    const jobConclusions = run.jobs.length > 0 ? run.jobs.map((j) => j.conclusion) : [run.conclusion];
    for (const conclusion of jobConclusions) {
      if (conclusion === null) {
        partialData = true;
      } else if (conclusion === "failure") {
        sawFailure = true;
      } else if (conclusion === "cancelled") {
        sawCancelled = true;
      } else if (conclusion === "pending" || conclusion === "skipped") {
        sawPending = true;
      }
    }
  }

  if (sawFailure) return { score: CI_SIGNAL_FAILURE, partialData };
  if (sawCancelled) return { score: CI_SIGNAL_CANCELLED, partialData };
  if (sawPending) return { score: CI_SIGNAL_SKIPPED_OR_PENDING, partialData: true };
  return { score: CI_SIGNAL_SUCCESS, partialData };
}

// A diff at or above this size gets full "size risk" credit.
const LARGE_DIFF_LINE_COUNT = 500;
const CONFIG_FILE_PATTERNS = [".env*", "*.config.*", "*.yml", "*.yaml", "Dockerfile*", "*.tf"];

export function prRiskScore(pr: CandidatePullRequest, changedFiles: string[]): number {
  const sizeRisk = Math.min(1, (pr.additions + pr.deletions) / LARGE_DIFF_LINE_COUNT);
  const touchesConfig = changedFiles.some((f) => CONFIG_FILE_PATTERNS.some((p) => pathMatches(f, p)));
  const isRevert = /revert/i.test(pr.title);

  let risk = sizeRisk * 0.7 + (touchesConfig ? 0.3 : 0);
  if (isRevert) risk *= 0.5; // a revert is fixing a regression more often than causing a new one
  return Math.min(1, risk);
}

export interface ScoreCommitParams {
  commit: CommitNode;
  deployedAt: Date;
  firstUnhealthyAt: Date;
  servicePathPatterns: string[];
  ancestryComplete: boolean;
}

export function scoreCommit(params: ScoreCommitParams, weights: ScoringWeights = DEFAULT_WEIGHTS): ScoreBreakdown {
  const { commit, deployedAt, firstUnhealthyAt, servicePathPatterns, ancestryComplete } = params;

  const timeProximity = timeProximityScore(deployedAt, firstUnhealthyAt);
  const fileOverlap = ancestryComplete ? fileOverlapScore(commit.changedFiles, servicePathPatterns) : 0;
  const { score: ciSignal, partialData: ciPartial } = commit.pullRequest
    ? ciSignalScore(commit.pullRequest.ciRuns)
    : { score: CI_SIGNAL_NO_DATA, partialData: true };
  const prRisk = commit.pullRequest ? prRiskScore(commit.pullRequest, commit.changedFiles) : 0;

  return {
    timeProximity: round(timeProximity),
    fileOverlap: round(fileOverlap),
    ciSignal: round(ciSignal),
    prRisk: round(prRisk),
    partialData: !ancestryComplete || ciPartial,
  };
}

export function weightedTotal(breakdown: ScoreBreakdown, weights: ScoringWeights = DEFAULT_WEIGHTS): number {
  return round(
    breakdown.timeProximity * weights.timeProximity +
      breakdown.fileOverlap * weights.fileOverlap +
      breakdown.ciSignal * weights.ciSignal +
      breakdown.prRisk * weights.prRisk,
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
