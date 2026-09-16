import type { Octokit } from "@octokit/rest";
import type { GithubApiClient } from "./github-types";

/**
 * Adapts a real Octokit instance to our narrow GithubApiClient interface.
 * Octokit's generated types mark almost every field optional (`?:`) even
 * when GitHub always sends it, which TypeScript won't structurally match
 * against our stricter (`| null`) DTOs. Rather than loosen every field in
 * github-types.ts to `| undefined` "just in case", this single cast is the
 * one place that acknowledges Octokit's looser typing -- the shapes are
 * genuinely compatible at runtime, since GitHub does send these fields.
 */
export function toGithubApiClient(octokit: Octokit): GithubApiClient {
  return octokit as unknown as GithubApiClient;
}
