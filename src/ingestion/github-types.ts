// Narrow, hand-written types for exactly the GitHub REST fields CodePulse
// reads. A real Octokit client structurally satisfies GithubApiClient (its
// responses are supersets of these shapes), so production code just passes
// `new Octokit({ auth })` in. Tests pass a plain object literal instead --
// no HTTP mocking library needed.

export interface GithubCommitDTO {
  sha: string;
  parents: { sha: string }[];
  commit: {
    message: string;
    author: { name: string | null; email: string | null; date: string } | null;
  };
}

export interface GithubCommitFileDTO {
  filename: string;
  status: string; // "added" | "modified" | "removed" | ...
}

export interface GithubCommitDetailDTO extends GithubCommitDTO {
  files?: GithubCommitFileDTO[];
}

export interface GithubPullDTO {
  number: number;
  title: string;
  user: { login: string } | null;
  base: { sha: string };
  head: { sha: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  labels: { name: string }[];
  merged_at: string | null;
}

export interface GithubWorkflowRunDTO {
  id: number;
  name: string | null;
  head_sha: string;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null;
  run_started_at: string | null;
  updated_at: string;
  pull_requests?: { number: number }[] | null;
}

export interface GithubJobDTO {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GithubApiResponse<T> {
  data: T;
  headers: Record<string, string | undefined>;
}

export interface GithubApiClient {
  rest: {
    repos: {
      listCommits(params: {
        owner: string;
        repo: string;
        per_page: number;
        page: number;
        since?: string;
      }): Promise<GithubApiResponse<GithubCommitDTO[]>>;
      getCommit(params: { owner: string; repo: string; ref: string }): Promise<GithubApiResponse<GithubCommitDetailDTO>>;
    };
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: "all";
        per_page: number;
        page: number;
        sort: "updated";
        direction: "desc";
      }): Promise<GithubApiResponse<GithubPullDTO[]>>;
    };
    actions: {
      listWorkflowRunsForRepo(params: {
        owner: string;
        repo: string;
        per_page: number;
        page: number;
      }): Promise<GithubApiResponse<{ workflow_runs: GithubWorkflowRunDTO[] }>>;
      listJobsForWorkflowRun(params: {
        owner: string;
        repo: string;
        run_id: number;
      }): Promise<GithubApiResponse<{ jobs: GithubJobDTO[] }>>;
    };
  };
}

/** Thrown by a real Octokit client on a 4xx/5xx; we only special-case rate limiting. */
export interface GithubApiError {
  status: number;
  response?: { headers?: Record<string, string | undefined> };
}

export function isGithubApiError(err: unknown): err is GithubApiError {
  return typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number";
}

export function isRateLimitError(err: unknown): boolean {
  if (!isGithubApiError(err)) return false;
  // GitHub uses 403 for both auth problems and rate limiting, and 429 for
  // secondary rate limits; the remaining-quota header is what actually
  // distinguishes "out of quota" from "wrong token".
  const remaining = err.response?.headers?.["x-ratelimit-remaining"];
  return err.status === 429 || (err.status === 403 && remaining === "0");
}
