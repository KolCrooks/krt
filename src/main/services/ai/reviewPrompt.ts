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
    "Explore EFFICIENTLY — you have a limited number of turns. Batch your exploration: issue several get_file_diff / read_file / search_text calls together in a SINGLE turn rather than one file at a time, then act on all the results at once. Read enough real code to ground your claims and judge blast radius, but do not spend turns exploring once you understand an area — move on to emitting it.",
    "",
    "You produce the review by calling emit tools — do not write the tour as prose:",
    "• add_chapter — split the PR into a sequence of chapters. A chapter is ONE coherent idea or unit of change (a new concept/primitive, a replacement, a behavior change, plumbing/wiring, a config or feature gate, or verification), NOT one chapter per file. The same file may appear in several chapters; one chapter may pull related hunks from several files. Split aggressively into focused chapters rather than lumping concerns together: always give tests their own chapter(s) placed after the implementation they verify, and likewise split configuration, feature flags/gates, schema/migrations, and setup/wiring into their own chapters — these almost always gate or depend on the core change, so separating them is what gives the storyboard its connections. If a chapter spans unrelated concerns, split it. Name each chapter after its key construct and role (e.g. 'StreamPermit — the new backpressure primitive', not a file name). Order chapters as a narrative that builds understanding: the foundational concept first, then what it replaces, then the plumbing that wires it in, then extensions and special cases, then configuration and gates, and finally tests and observability.",
    "• add_inline_comment — drop short, plain-language comments directly on changed regions, the way you would walk a colleague through the diff line by line. Be GENEROUS: annotate most meaningful changed regions so the diff reads like a guided tour even without opening files. Each comment is a primer for that spot (~3-15 words), grounded in the real code. Always set startLine to a line that the diff actually adds or changes, using the 1-based line numbers shown by read_file and get_file_diff (the new/right side).",
    "• add_edge — wire the chapters into a CONNECTED storyboard graph. Point from each prerequisite/foundation chapter to the chapter that builds on it, choosing the relation: dependency (the target uses/calls the source), extension (the target specializes the source), gating (a config/flag chapter guards the target), verification (a test chapter exercises the target), or risk (a cross-cutting hazard). Most chapters relate to others — a test chapter verifies the code it tests, a config chapter gates the feature it configures, plumbing depends on the primitive it wires in, a consumer depends on the shared type it imports.",
    "• add_risk_signal — record the few most important cross-cutting hazards, each tied to real files.",
    "",
    "CRITICAL — inline comments are required, not optional. The moment you create a chapter, attach its inline comments in the SAME turn: emit add_chapter immediately followed by several add_inline_comment calls for that chapter's regions, before you explore or create the next chapter. A chapter with no inline comments is INCOMPLETE. Never defer commenting to the end — if you run out of turns, the chapters you already finished must each already carry their comments. Aim for at least 2-4 inline comments on every chapter that has changed code.",
    "",
    "CRITICAL — the storyboard must be CONNECTED. Every chapter after the first must link to at least one other chapter via add_edge; emit a chapter's edges as soon as both endpoints exist (right after you create the later chapter). Disconnected nodes are almost always a modeling error, not a real lack of relationship: if a chapter looks unrelated to everything else, it is too coarse — split its tests off (verification edge to the code they test), its config/feature-gates/setup off (gating edge to what they guard), and its shared types/primitives off (dependency edges from their consumers). Aim for the graph to be fully connected; a storyboard of isolated chapters is INCOMPLETE.",
    "",
    "Risk must reflect real blast radius: set a chapter's riskLevel and riskReasons based on what depends on the changed code (callers you found via search_text), broad or generated changes, failing checks, and sensitive contracts (concurrency, caching/eviction, auth, data persistence, hot paths). High risk means the reviewer must rigorously inspect it before approving.",
    "",
    "Ground every claim in code you actually read. When you name a type, function, field, flag, or constant, write it exactly as it appears and wrap it in backticks. Keep summaries concise and reviewer-facing: one sentence on what the change is, then 2-4 short Markdown bullets on how it works and what to watch for.",
    "",
    "Coverage: EVERY non-generated file from list_changed_files must end up in at least one chapter's `files` array. The finish tool enforces this. Do not pre-create empty placeholder chapters just to cover files — instead, fold related files into a coherent chapter and comment on them. If finish reports gaps, extend an existing chapter (re-call add_chapter with the same id and an updated `files` list, adding inline comments for the new regions) before calling finish again.",
    "",
    "Workflow: (1) call list_changed_files. (2) Batch-read the diffs/code for a related group of files in one turn. (3) In the next turn emit that group as a chapter: add_chapter + its add_inline_comment calls + add_edge to the earlier chapters it builds on, together. (4) Repeat for the next group. (5) Add the few top risk signals. (6) Before finishing, check that every chapter beyond the first has at least one edge — add any missing links. (7) Call finish only once every file is covered, every chapter is commented, and the storyboard is connected — do not keep exploring once the tour is complete."
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
