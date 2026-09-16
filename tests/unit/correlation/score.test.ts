import { describe, it, expect } from "vitest";
import {
  timeProximityScore,
  pathMatches,
  fileOverlapScore,
  ciSignalScore,
  prRiskScore,
  scoreCommit,
  weightedTotal,
} from "@/src/correlation/score";
import type { CandidatePullRequest, CommitNode } from "@/src/correlation/types";

describe("timeProximityScore", () => {
  const incidentAt = new Date("2026-01-01T12:00:00Z");

  it("scores a deploy at the exact incident moment as 1.0", () => {
    expect(timeProximityScore(incidentAt, incidentAt)).toBe(1);
  });

  it("decays roughly to 0.5 at the half-life", () => {
    const deployedAt = new Date(incidentAt.getTime() - 15 * 60 * 1000);
    expect(timeProximityScore(deployedAt, incidentAt)).toBeCloseTo(0.5, 2);
  });

  it("scores a deploy after the incident as 0 -- it cannot be the cause", () => {
    const deployedAt = new Date(incidentAt.getTime() + 1000);
    expect(timeProximityScore(deployedAt, incidentAt)).toBe(0);
  });

  it("scores a deploy well past the cutoff window as 0", () => {
    const deployedAt = new Date(incidentAt.getTime() - 3 * 60 * 60 * 1000);
    expect(timeProximityScore(deployedAt, incidentAt)).toBe(0);
  });
});

describe("pathMatches", () => {
  it("matches an exact literal path", () => {
    expect(pathMatches("src/index.ts", "src/index.ts")).toBe(true);
  });

  it("matches '**' across any depth", () => {
    expect(pathMatches("src/payments/stripe/webhook.ts", "src/payments/**")).toBe(true);
  });

  it("does not match '**' outside its own subtree", () => {
    expect(pathMatches("src/billing/invoice.ts", "src/payments/**")).toBe(false);
  });

  it("matches a single '*' within one path segment only", () => {
    expect(pathMatches("config.yml", "*.yml")).toBe(true);
    expect(pathMatches("nested/config.yml", "*.yml")).toBe(false);
  });
});

describe("fileOverlapScore", () => {
  it("is the fraction of changed files owned by the service", () => {
    const files = ["src/payments/a.ts", "src/payments/b.ts", "src/unrelated/c.ts", "src/unrelated/d.ts"];
    expect(fileOverlapScore(files, ["src/payments/**"])).toBeCloseTo(0.5, 5);
  });

  it("is 0 when nothing overlaps", () => {
    expect(fileOverlapScore(["src/unrelated/c.ts"], ["src/payments/**"])).toBe(0);
  });

  it("is 0 for an empty file list", () => {
    expect(fileOverlapScore([], ["src/payments/**"])).toBe(0);
  });
});

describe("ciSignalScore", () => {
  it("returns high suspicion when any job failed", () => {
    const { score, partialData } = ciSignalScore([{ conclusion: "success", jobs: [{ conclusion: "failure" }] }]);
    expect(score).toBe(1.0);
    expect(partialData).toBe(false);
  });

  it("returns low suspicion when everything succeeded", () => {
    const { score, partialData } = ciSignalScore([{ conclusion: "success", jobs: [{ conclusion: "success" }] }]);
    expect(score).toBeLessThan(0.2);
    expect(partialData).toBe(false);
  });

  it("flags partialData and returns a neutral score with no CI runs at all", () => {
    const { score, partialData } = ciSignalScore([]);
    expect(partialData).toBe(true);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("flags partialData when a job's conclusion is still null (in flight)", () => {
    const { partialData } = ciSignalScore([{ conclusion: null, jobs: [{ conclusion: null }] }]);
    expect(partialData).toBe(true);
  });
});

describe("prRiskScore", () => {
  const basePr: CandidatePullRequest = {
    number: 1,
    title: "Add feature",
    additions: 10,
    deletions: 5,
    labels: [],
    ciRuns: [],
  };

  it("scores a small PR touching unrelated files as low risk", () => {
    expect(prRiskScore(basePr, ["src/app/page.tsx"])).toBeLessThan(0.1);
  });

  it("scores a large diff higher than a small one", () => {
    const small = prRiskScore(basePr, ["src/app/page.tsx"]);
    const large = prRiskScore({ ...basePr, additions: 400, deletions: 300 }, ["src/app/page.tsx"]);
    expect(large).toBeGreaterThan(small);
  });

  it("adds risk for touching config/infra files", () => {
    const withoutConfig = prRiskScore(basePr, ["src/app/page.tsx"]);
    const withConfig = prRiskScore(basePr, ["docker-compose.yml"]);
    expect(withConfig).toBeGreaterThan(withoutConfig);
  });

  it("discounts risk for a revert PR", () => {
    const normal = prRiskScore({ ...basePr, additions: 400, deletions: 300 }, ["docker-compose.yml"]);
    const revert = prRiskScore(
      { ...basePr, title: "Revert \"Add feature\"", additions: 400, deletions: 300 },
      ["docker-compose.yml"],
    );
    expect(revert).toBeLessThan(normal);
  });

  it("never exceeds 1", () => {
    const huge = prRiskScore({ ...basePr, additions: 5000, deletions: 5000 }, ["docker-compose.yml"]);
    expect(huge).toBeLessThanOrEqual(1);
  });
});

describe("scoreCommit + weightedTotal", () => {
  const firstUnhealthyAt = new Date("2026-01-01T12:00:00Z");
  const deployedAt = new Date("2026-01-01T11:55:00Z");

  function makeCommit(overrides: Partial<CommitNode> = {}): CommitNode {
    return {
      sha: "abc123",
      parentShas: [],
      committedAt: deployedAt,
      changedFiles: ["src/payments/checkout.ts"],
      pullRequest: null,
      ...overrides,
    };
  }

  it("produces a higher total score for a suspicious commit than a benign one", () => {
    const suspicious = makeCommit({
      pullRequest: {
        number: 42,
        title: "Rework checkout retries",
        additions: 600,
        deletions: 200,
        labels: [],
        ciRuns: [{ conclusion: "failure", jobs: [{ conclusion: "failure" }] }],
      },
    });
    const benign = makeCommit({
      changedFiles: ["docs/README.md"],
      pullRequest: {
        number: 43,
        title: "Fix typo in docs",
        additions: 1,
        deletions: 1,
        labels: [],
        ciRuns: [{ conclusion: "success", jobs: [{ conclusion: "success" }] }],
      },
    });

    const suspiciousScore = weightedTotal(
      scoreCommit({
        commit: suspicious,
        deployedAt,
        firstUnhealthyAt,
        servicePathPatterns: ["src/payments/**"],
        ancestryComplete: true,
      }),
    );
    const benignScore = weightedTotal(
      scoreCommit({
        commit: benign,
        deployedAt,
        firstUnhealthyAt,
        servicePathPatterns: ["src/payments/**"],
        ancestryComplete: true,
      }),
    );

    expect(suspiciousScore).toBeGreaterThan(benignScore);
  });

  it("marks partialData and zeroes fileOverlap when ancestry could not be resolved", () => {
    const breakdown = scoreCommit({
      commit: makeCommit(),
      deployedAt,
      firstUnhealthyAt,
      servicePathPatterns: ["src/payments/**"],
      ancestryComplete: false,
    });

    expect(breakdown.partialData).toBe(true);
    expect(breakdown.fileOverlap).toBe(0);
  });

  it("keeps the weighted total within [0, 1]", () => {
    const breakdown = scoreCommit({
      commit: makeCommit({
        pullRequest: {
          number: 1,
          title: "x",
          additions: 9999,
          deletions: 9999,
          labels: [],
          ciRuns: [{ conclusion: "failure", jobs: [] }],
        },
      }),
      deployedAt,
      firstUnhealthyAt,
      servicePathPatterns: ["src/payments/**"],
      ancestryComplete: true,
    });
    const total = weightedTotal(breakdown);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);
  });
});
