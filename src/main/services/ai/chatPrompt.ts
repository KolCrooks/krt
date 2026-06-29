import type { PullRequestDetail, ReviewTour } from "../../../shared/schemas.js";
import { redactTextForAi } from "../redactionService.js";

const MAX_SUMMARY_CHARS = 600;

// System prompt for the tour-chat agent. Unlike generation, the agent does NOT
// emit tools — it answers the reviewer's questions in plain prose. It is given
// the already-generated tour as grounding and the read-only exploration tools so
// it can dig deeper into the checked-out code when a question goes beyond the tour.
export function buildChatSystemPrompt(pullRequest: PullRequestDetail, tour: ReviewTour): string {
  return [
    "You are a senior software engineer who has already produced a guided review tour of a pull request, and are now answering a reviewer's questions about it in a chat.",
    "Answer the reviewer's questions about the change, its stories/chapters, the risks, and how the pieces fit together. Be concise, specific, and grounded in the actual code.",
    "",
    "You can explore the checked-out repository with read-only tools: list_changed_files, get_file_diff, read_file, search_text, list_files, get_blast_radius. Use them to verify claims and answer questions that go beyond the tour, but only when needed — if the tour already answers the question, just answer.",
    "",
    "Reply in plain Markdown prose — do NOT call any emit/finish tools (there are none). When you have the answer, just write it; calling no tool ends your turn. When you name a type, function, field, or constant, write it exactly as it appears and wrap it in backticks. When you reference a chapter, use its title. If you are unsure or the available context cannot answer the question, say so plainly rather than guessing.",
    "",
    "Here is the pull request and the tour you generated:",
    "",
    buildTourContext(pullRequest, tour)
  ].join("\n");
}

function buildTourContext(pullRequest: PullRequestDetail, tour: ReviewTour): string {
  const lines: string[] = [
    `Pull request #${pullRequest.number}: ${redactTextForAi(pullRequest.title)}`,
    `Branch: ${pullRequest.baseRef} ← ${pullRequest.headRef} (head ${pullRequest.headSha})`,
    "",
    `Tour chapters (${tour.chapters.length}):`
  ];

  tour.chapters.forEach((chapter, index) => {
    const summary = chapter.summary ? redactTextForAi(chapter.summary).slice(0, MAX_SUMMARY_CHARS) : "(no summary)";
    lines.push(
      `${index + 1}. [${chapter.id}] ${redactTextForAi(chapter.title)} — risk: ${chapter.riskLevel}`,
      `   files: ${chapter.files.join(", ") || "(none)"}`,
      `   ${summary.replace(/\n+/g, " ")}`
    );
  });

  if (tour.graph.edges.length > 0) {
    lines.push("", "Chapter relationships:");
    for (const edge of tour.graph.edges) {
      lines.push(`   ${edge.from} → ${edge.to} (${edge.relation})${edge.reason ? `: ${edge.reason}` : ""}`);
    }
  }

  if (tour.riskSignals.length > 0) {
    lines.push("", "Top risks:");
    for (const risk of tour.riskSignals) {
      lines.push(`   [${risk.level}] ${redactTextForAi(risk.title)}: ${redactTextForAi(risk.reason)}`);
    }
  }

  return lines.join("\n");
}
