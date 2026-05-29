import type { ActivityEvent, ChangedFile, CheckRun, PullRequestDetail, ReviewThread } from "../../../shared/schemas.js";
import { redactTextForAi } from "../redactionService.js";

export interface ReviewPromptInput {
  pullRequest: PullRequestDetail;
  changedFiles: ChangedFile[];
  timeline: ActivityEvent[];
  reviewThreads: ReviewThread[];
  checks: CheckRun[];
}

const MAX_BODY_CHARS = 4_000;

// The mission and contract for the review agent. The agent is expected to
// EXPLORE the real checked-out repository with its tools and then EMIT the tour
// by calling tools — it never returns the tour as free-form text.
export function buildReviewSystemPrompt(): string {
  return [
    "You are a senior software engineer giving another reviewer a guided walkthrough of a pull request.",
    "Your goal is to help them understand the change deeply and know exactly what to scrutinize before approving — not to summarize files.",
    "",
    "You can explore the ACTUAL checked-out repository with tools: list_changed_files, get_file_diff, read_file, search_text, list_files.",
    "Use them aggressively. Read the real code around each change, follow symbols to their definitions and call sites with search_text, and work out how each change connects to the rest of the codebase and what its blast radius is. Never guess where you can look.",
    "",
    "You produce the review by calling emit tools — do not write the tour as prose:",
    "• add_chapter — split the PR into a sequence of chapters. A chapter is ONE coherent idea or unit of change (a new concept/primitive, a replacement, a behavior change, plumbing/wiring, a config or feature gate, or verification), NOT one chapter per file. The same file may appear in several chapters; one chapter may pull related hunks from several files. Always give tests their own chapter(s), placed after the implementation they verify. Name each chapter after its key construct and role (e.g. 'StreamPermit — the new backpressure primitive', not a file name). Order chapters as a narrative that builds understanding: the foundational concept first, then what it replaces, then the plumbing that wires it in, then extensions and special cases, then configuration and gates, and finally tests and observability.",
    "• add_inline_comment — drop short, plain-language comments directly on changed regions, the way you would walk a colleague through the diff line by line. Be GENEROUS: annotate most meaningful changed regions so the diff reads like a guided tour even without opening files. Each comment is a primer for that spot (~3-15 words), grounded in the real code. Always set startLine to a line that the diff actually adds or changes, using the 1-based line numbers shown by read_file and get_file_diff (the new/right side); call add_chapter for the chapter first, then attach its inline comments.",
    "• add_edge — connect the chapters into the storyboard dependency graph, pointing from each prerequisite/foundation chapter to the chapter that builds on it. Pick the relation that fits: dependency, extension, gating, verification, or risk.",
    "• add_risk_signal — record the few most important cross-cutting hazards, each tied to real files.",
    "",
    "Risk must reflect real blast radius: set a chapter's riskLevel and riskReasons based on what depends on the changed code (callers you found via search_text), broad or generated changes, failing checks, and sensitive contracts (concurrency, caching/eviction, auth, data persistence, hot paths). High risk means the reviewer must rigorously inspect it before approving.",
    "",
    "Ground every claim in code you actually read. When you name a type, function, field, flag, or constant, write it exactly as it appears and wrap it in backticks. Keep summaries concise and reviewer-facing: one sentence on what the change is, then 2-4 short Markdown bullets on how it works and what to watch for.",
    "",
    "Workflow: start by calling list_changed_files. For each area, read its diff and the surrounding code and search for its callers; then add_chapter for it, add_inline_comment across its regions, and add_edge to connect it to the chapters it depends on. Record risk signals for cross-cutting hazards. When every meaningful change is covered, call finish."
  ].join("\n");
}

export function buildReviewUserMessage(input: ReviewPromptInput): string {
  const pr = input.pullRequest;
  const failingChecks = input.checks.filter((check) => check.conclusion === "failure" || check.conclusion === "timed_out");
  const unresolvedThreads = input.reviewThreads.filter((thread) => !thread.resolved).length;
  const body = pr.body ? redactTextForAi(pr.body).slice(0, MAX_BODY_CHARS) : "(no description provided)";

  const lines = [
    `Pull request #${pr.number}: ${redactTextForAi(pr.title)}`,
    `Author: ${pr.author.login}`,
    `Branch: ${pr.baseRef} ← ${pr.headRef} (head ${pr.headSha})`,
    `Changed files: ${input.changedFiles.length} (additions +${pr.additions}, deletions -${pr.deletions})`,
    failingChecks.length > 0 ? `Failing checks: ${failingChecks.map((check) => check.name).join(", ")}` : null,
    unresolvedThreads > 0 ? `Unresolved review threads: ${unresolvedThreads}` : null,
    "",
    "Description:",
    body,
    "",
    "Explore the repository with your tools and build the guided review tour. Call list_changed_files first, then read diffs and surrounding code before writing chapters. Call finish when the tour is complete."
  ];
  return lines.filter((line) => line !== null).join("\n");
}
