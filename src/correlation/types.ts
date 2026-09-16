// Plain-data types for the correlation engine. Deliberately decoupled from
// the DB schema (src/db/schema.ts): the engine is a pure function of these
// shapes, so it can be unit tested with plain objects and never needs a
// database connection. src/correlation/load.ts is the only module that
// knows how to build these from Postgres rows.

export type CiConclusion = "success" | "failure" | "cancelled" | "skipped" | "pending" | null;

export interface CandidateCiRun {
  conclusion: CiConclusion;
  jobs: { conclusion: CiConclusion }[];
}

export interface CandidatePullRequest {
  number: number;
  title: string;
  additions: number;
  deletions: number;
  labels: string[];
  ciRuns: CandidateCiRun[];
}

export interface CommitNode {
  sha: string;
  parentShas: string[];
  committedAt: Date;
  changedFiles: string[];
  pullRequest: CandidatePullRequest | null;
}

export interface CandidateDeployment {
  id: number;
  fromSha: string | null;
  toSha: string;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ScoringInput {
  firstUnhealthyAt: Date;
  /** glob-style path patterns this incident's service owns, e.g. "src/payments/**" */
  servicePathPatterns: string[];
  /** deployments to consider, already filtered to "before firstUnhealthyAt" and within a lookback window */
  deployments: CandidateDeployment[];
  /** every commit known to the engine, keyed by sha, used to walk ancestry for each deployment */
  commitsBySha: Map<string, CommitNode>;
}

export interface ScoreBreakdown {
  timeProximity: number;
  fileOverlap: number;
  ciSignal: number;
  prRisk: number;
  /** true if this candidate's score is based on incomplete data (missing ancestry and/or missing CI info) */
  partialData: boolean;
}

export interface RankedCandidate {
  candidateType: "commit" | "pull_request";
  candidateRef: string; // commit sha, or PR number as string
  deploymentId: number;
  score: number;
  breakdown: ScoreBreakdown;
}

export interface ScoringWeights {
  timeProximity: number;
  fileOverlap: number;
  ciSignal: number;
  prRisk: number;
}
