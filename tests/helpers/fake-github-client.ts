import type {
  GithubApiClient,
  GithubCommitDetailDTO,
  GithubJobDTO,
  GithubPullDTO,
  GithubWorkflowRunDTO,
} from "@/src/ingestion/github-types";

const PAGE_SIZE = 100;

function page<T>(items: T[], pageNumber: number): T[] {
  const start = (pageNumber - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

export interface FakeGithubData {
  commits?: GithubCommitDetailDTO[];
  pulls?: GithubPullDTO[];
  workflowRuns?: GithubWorkflowRunDTO[];
  jobsByRunId?: Record<number, GithubJobDTO[]>;
  /** Throw a rate-limit error once listCommits is asked for a page past this one. */
  rateLimitAfterCommitPage?: number;
}

/** A hand-written test double satisfying GithubApiClient -- no HTTP mocking library needed. */
export function makeFakeGithubClient(data: FakeGithubData): GithubApiClient {
  return {
    rest: {
      repos: {
        async listCommits({ page: pageNumber }) {
          if (data.rateLimitAfterCommitPage !== undefined && pageNumber > data.rateLimitAfterCommitPage) {
            const err = { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } };
            throw err;
          }
          return { data: page(data.commits ?? [], pageNumber), headers: { "x-ratelimit-remaining": "4999" } };
        },
        async getCommit({ ref }) {
          const found = (data.commits ?? []).find((c) => c.sha === ref);
          return {
            data: found ?? { sha: ref, parents: [], commit: { message: "", author: null }, files: [] },
            headers: {},
          };
        },
      },
      pulls: {
        async list({ page: pageNumber }) {
          return { data: page(data.pulls ?? [], pageNumber), headers: {} };
        },
      },
      actions: {
        async listWorkflowRunsForRepo({ page: pageNumber }) {
          return { data: { workflow_runs: page(data.workflowRuns ?? [], pageNumber) }, headers: {} };
        },
        async listJobsForWorkflowRun({ run_id }) {
          return { data: { jobs: data.jobsByRunId?.[run_id] ?? [] }, headers: {} };
        },
      },
    },
  };
}
