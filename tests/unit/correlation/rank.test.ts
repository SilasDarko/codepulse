import { describe, it, expect } from "vitest";
import { rankCandidates } from "@/src/correlation/rank";
import type { CommitNode, ScoringInput } from "@/src/correlation/types";

const firstUnhealthyAt = new Date("2026-01-01T12:00:00Z");

function commit(sha: string, parentShas: string[], overrides: Partial<CommitNode> = {}): CommitNode {
  return {
    sha,
    parentShas,
    committedAt: new Date("2026-01-01T11:55:00Z"),
    changedFiles: [],
    pullRequest: null,
    ...overrides,
  };
}

describe("rankCandidates", () => {
  it("ranks the commit that touched the affected service just before the incident above an unrelated one", () => {
    const guilty = commit("guilty", [], {
      changedFiles: ["src/payments/checkout.ts"],
      pullRequest: { number: 1, title: "Rework checkout", additions: 300, deletions: 100, labels: [], ciRuns: [] },
    });
    const innocent = commit("innocent", [], {
      changedFiles: ["docs/README.md"],
      pullRequest: { number: 2, title: "Fix typo", additions: 1, deletions: 1, labels: [], ciRuns: [] },
    });

    const commitsBySha = new Map([
      ["guilty", guilty],
      ["innocent", innocent],
    ]);

    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: ["src/payments/**"],
      commitsBySha,
      deployments: [
        {
          id: 1,
          fromSha: null,
          toSha: "guilty",
          startedAt: new Date("2026-01-01T11:50:00Z"),
          completedAt: new Date("2026-01-01T11:55:00Z"),
        },
        {
          id: 2,
          fromSha: null,
          toSha: "innocent",
          startedAt: new Date("2026-01-01T09:00:00Z"),
          completedAt: new Date("2026-01-01T09:05:00Z"),
        },
      ],
    };

    const ranked = rankCandidates(input);
    const top = ranked[0];

    expect(top?.candidateType).toBe("commit");
    expect(top?.candidateRef).toBe("guilty");
  });

  it("emits a pull_request candidate alongside its commit candidate", () => {
    const c = commit("c1", [], {
      pullRequest: { number: 7, title: "Change", additions: 10, deletions: 5, labels: [], ciRuns: [] },
    });
    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: [],
      commitsBySha: new Map([["c1", c]]),
      deployments: [{ id: 1, fromSha: null, toSha: "c1", startedAt: firstUnhealthyAt, completedAt: firstUnhealthyAt }],
    };

    const ranked = rankCandidates(input);

    expect(ranked.some((r) => r.candidateType === "commit" && r.candidateRef === "c1")).toBe(true);
    expect(ranked.some((r) => r.candidateType === "pull_request" && r.candidateRef === "7")).toBe(true);
  });

  it("does not emit a pull_request candidate for a direct-push commit with no PR", () => {
    const c = commit("c1", []);
    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: [],
      commitsBySha: new Map([["c1", c]]),
      deployments: [{ id: 1, fromSha: null, toSha: "c1", startedAt: firstUnhealthyAt, completedAt: firstUnhealthyAt }],
    };

    const ranked = rankCandidates(input);

    expect(ranked.every((r) => r.candidateType === "commit")).toBe(true);
  });

  it("keeps only the highest-scoring occurrence of a PR that spans multiple deployments", () => {
    const c1 = commit("c1", [], {
      changedFiles: ["src/payments/a.ts"],
      pullRequest: { number: 9, title: "x", additions: 10, deletions: 5, labels: [], ciRuns: [] },
    });
    const c2 = commit("c2", [], {
      changedFiles: ["src/payments/a.ts"],
      pullRequest: { number: 9, title: "x", additions: 10, deletions: 5, labels: [], ciRuns: [] },
    });

    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: ["src/payments/**"],
      commitsBySha: new Map([
        ["c1", c1],
        ["c2", c2],
      ]),
      deployments: [
        // far from the incident -> low time-proximity score
        { id: 1, fromSha: null, toSha: "c1", startedAt: new Date("2026-01-01T08:00:00Z"), completedAt: new Date("2026-01-01T08:00:00Z") },
        // right before the incident -> high time-proximity score
        { id: 2, fromSha: null, toSha: "c2", startedAt: firstUnhealthyAt, completedAt: firstUnhealthyAt },
      ],
    };

    const ranked = rankCandidates(input);
    const prCandidates = ranked.filter((r) => r.candidateType === "pull_request" && r.candidateRef === "9");

    expect(prCandidates).toHaveLength(1);
    expect(prCandidates[0]?.deploymentId).toBe(2);
  });

  it("returns an empty list when there are no deployments to consider", () => {
    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: [],
      commitsBySha: new Map(),
      deployments: [],
    };
    expect(rankCandidates(input)).toEqual([]);
  });

  it("still ranks a commit whose ancestry could not be fully resolved instead of throwing", () => {
    // fromSha points at a commit we never ingested -- ancestry walk will be incomplete.
    const c = commit("c1", ["missing-ancestor"]);
    const input: ScoringInput = {
      firstUnhealthyAt,
      servicePathPatterns: ["src/payments/**"],
      commitsBySha: new Map([["c1", c]]),
      deployments: [
        { id: 1, fromSha: "some-very-old-sha", toSha: "c1", startedAt: firstUnhealthyAt, completedAt: firstUnhealthyAt },
      ],
    };

    expect(() => rankCandidates(input)).not.toThrow();
    const ranked = rankCandidates(input);
    expect(ranked[0]?.breakdown.partialData).toBe(true);
  });
});
