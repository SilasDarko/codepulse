import type { CommitNode } from "./types";

export interface CommitRange {
  /** commits reachable from `toSha` going backward through parent links, stopping at `fromSha` */
  commits: CommitNode[];
  /**
   * false if the walk hit a parent SHA that isn't in `commitsBySha` before reaching `fromSha`
   * (a shallow-cloned or partially-ingested history) -- callers must degrade gracefully, not crash.
   */
  complete: boolean;
}

/**
 * Walks commit ancestry backward from `toSha`, collecting every commit up to
 * and including `fromSha` (exclusive of fromSha itself, since fromSha was
 * already live before this deployment). If `fromSha` is null, walks the
 * single commit at `toSha` only -- the "first known deployment" case.
 */
export function resolveCommitRange(
  commitsBySha: Map<string, CommitNode>,
  fromSha: string | null,
  toSha: string,
): CommitRange {
  const head = commitsBySha.get(toSha);
  if (!head) {
    return { commits: [], complete: false };
  }
  if (fromSha === null) {
    return { commits: [head], complete: true };
  }

  const collected: CommitNode[] = [];
  const seen = new Set<string>();
  const queue: string[] = [toSha];
  let complete = true;

  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha) || sha === fromSha) continue;
    seen.add(sha);

    const node = commitsBySha.get(sha);
    if (!node) {
      // A parent we don't have -- history is incomplete beyond this point.
      complete = false;
      continue;
    }
    collected.push(node);
    for (const parent of node.parentShas) {
      if (parent !== fromSha && !seen.has(parent)) queue.push(parent);
      if (parent === fromSha) seen.add(parent); // reached the boundary, stop there
    }
  }

  return { commits: collected, complete };
}
