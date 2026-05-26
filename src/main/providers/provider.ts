import type {
  ActivityEvent,
  ChangedFile,
  CheckRun,
  FileContent,
  FilePatch,
  ProviderAccount,
  PullRequestBundle,
  PullRequestDetail,
  PullRequestSummary,
  ReactionContent,
  ReactionGroup,
  RepositoryCloneInfo,
  RepositoryRef,
  ReviewComment,
  ReviewSubmission,
  ReviewSubmissionResult,
  ReviewThread
} from "../../shared/schemas.js";

export interface PullRequestSearchInput {
  query: string;
  owner?: string;
  repo?: string;
  limit: number;
}

export interface Provider {
  readonly id: "github";
  fetchUser(): Promise<ProviderAccount>;
  listPullRequests(input: PullRequestSearchInput): Promise<PullRequestSummary[]>;
  getPullRequest(repository: RepositoryRef, number: number): Promise<PullRequestDetail>;
  getPullRequestTimeline(repository: RepositoryRef, number: number): Promise<ActivityEvent[]>;
  getReviewThreads(repository: RepositoryRef, number: number): Promise<ReviewThread[]>;
  getChecks(repository: RepositoryRef, ref: string): Promise<CheckRun[]>;
  getChangedFiles(repository: RepositoryRef, number: number): Promise<ChangedFile[]>;
  getPatch(repository: RepositoryRef, number: number, path: string, headSha: string): Promise<FilePatch>;
  getFileContent(repository: RepositoryRef, path: string, ref: string): Promise<FileContent>;
  postIssueComment(repository: RepositoryRef, number: number, body: string): Promise<ReviewComment>;
  replyToReviewThread(repository: RepositoryRef, threadId: string, body: string): Promise<ReviewComment>;
  resolveReviewThread(repository: RepositoryRef, number: number, threadId: string): Promise<ReviewThread>;
  reopenReviewThread(repository: RepositoryRef, number: number, threadId: string): Promise<ReviewThread>;
  toggleReaction(subjectId: string, content: ReactionContent, add: boolean): Promise<ReactionGroup[]>;
  submitReview(submission: ReviewSubmission): Promise<ReviewSubmissionResult>;
  getRepository(repository: RepositoryRef): Promise<RepositoryRef>;
  getCloneInfo(repository: RepositoryRef): Promise<RepositoryCloneInfo>;
  openPullRequest(repository: RepositoryRef, number: number, mode: "light" | "managed"): Promise<PullRequestBundle>;
}
