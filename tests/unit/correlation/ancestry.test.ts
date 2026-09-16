import { describe, it, expect } from "vitest";
import { resolveCommitRange } from "@/src/correlation/ancestry";
import type { CommitNode } from "@/src/correlation/types";

function commit(sha: string, parentShas: string[]): CommitNode {
  return { sha, parentShas, committedAt: new Date(), changedFiles: [], pullRequest: null };
}

describe("resolveCommitRange", () => {
  it("returns just the head commit when fromSha is null", () => {
    const c1 = commit("c1", []);
    const map = new Map([["c1", c1]]);

    const { commits, complete } = resolveCommitRange(map, null, "c1");

    expect(complete).toBe(true);
    expect(commits.map((c) => c.sha)).toEqual(["c1"]);
  });

  it("walks a linear chain from toSha back to (excluding) fromSha", () => {
    const c1 = commit("c1", []);
    const c2 = commit("c2", ["c1"]);
    const c3 = commit("c3", ["c2"]);
    const map = new Map([
      ["c1", c1],
      ["c2", c2],
      ["c3", c3],
    ]);

    const { commits, complete } = resolveCommitRange(map, "c1", "c3");

    expect(complete).toBe(true);
    expect(commits.map((c) => c.sha).sort()).toEqual(["c2", "c3"]);
  });

  it("walks both parents of a merge commit", () => {
    const base = commit("base", []);
    const feature = commit("feature", ["base"]);
    const mainline = commit("mainline", ["base"]);
    const merge = commit("merge", ["mainline", "feature"]);
    const map = new Map([
      ["base", base],
      ["feature", feature],
      ["mainline", mainline],
      ["merge", merge],
    ]);

    const { commits, complete } = resolveCommitRange(map, "base", "merge");

    expect(complete).toBe(true);
    expect(commits.map((c) => c.sha).sort()).toEqual(["feature", "mainline", "merge"]);
  });

  it("marks the range incomplete when a parent SHA is missing from the ingested set", () => {
    const c2 = commit("c2", ["missing-parent"]);
    const map = new Map([["c2", c2]]);

    const { commits, complete } = resolveCommitRange(map, "some-old-sha", "c2");

    expect(complete).toBe(false);
    expect(commits.map((c) => c.sha)).toEqual(["c2"]);
  });

  it("returns an empty, incomplete range when toSha itself is unknown", () => {
    const { commits, complete } = resolveCommitRange(new Map(), "a", "unknown");

    expect(complete).toBe(false);
    expect(commits).toEqual([]);
  });

  it("does not loop forever on a cycle-free but repeated-parent graph", () => {
    // c3's two parents both eventually reach c1 -- must not visit c1 twice or hang.
    const c1 = commit("c1", []);
    const c2a = commit("c2a", ["c1"]);
    const c2b = commit("c2b", ["c1"]);
    const c3 = commit("c3", ["c2a", "c2b"]);
    const map = new Map([
      ["c1", c1],
      ["c2a", c2a],
      ["c2b", c2b],
      ["c3", c3],
    ]);

    const { commits, complete } = resolveCommitRange(map, "c1", "c3");

    expect(complete).toBe(true);
    expect(commits.map((c) => c.sha).sort()).toEqual(["c2a", "c2b", "c3"]);
  });
});
