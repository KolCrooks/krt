import type { ReviewDraftComment, ReviewThread, TourChapter } from "./schemas.js";

export type DiffAnnotationKind = "review" | "ai" | "draft";

export interface DiffAnnotation {
  id: string;
  kind: DiffAnnotationKind;
  title: string;
  body: string;
  path: string;
  line?: number;
  endLine?: number;
  side?: "left" | "right";
  status: string;
  thread?: ReviewThread;
}

interface DiffAnnotationInput {
  filePath: string;
  reviewThreads?: readonly ReviewThread[];
  tourChapters?: readonly TourChapter[];
  draftComments?: readonly (ReviewDraftComment & { id: string })[];
}

export function buildDiffAnnotations({
  filePath,
  reviewThreads = [],
  tourChapters = [],
  draftComments = []
}: DiffAnnotationInput): DiffAnnotation[] {
  return [
    ...buildReviewAnnotations(filePath, reviewThreads),
    ...buildTourAnnotations(filePath, tourChapters),
    ...buildDraftAnnotations(filePath, draftComments)
  ].sort(compareDiffAnnotations);
}

function buildReviewAnnotations(filePath: string, reviewThreads: readonly ReviewThread[]): DiffAnnotation[] {
  return reviewThreads.flatMap((thread) => {
    const matchingComments = thread.comments.filter((comment) => (comment.path ?? thread.path) === filePath);
    if ((thread.path ?? matchingComments[0]?.path) !== filePath && matchingComments.length === 0) {
      return [];
    }

    const lastComment = matchingComments.at(-1) ?? thread.comments.at(-1);
    const author = lastComment?.author.login ?? "Review";
    return [
      {
        id: `review:${thread.id}`,
        kind: "review",
        title: `${author} review thread`,
        body: lastComment?.body ?? "Review thread",
        path: filePath,
        line: thread.line ?? lastComment?.line,
        side: lastComment?.side,
        status: thread.outdated ? "outdated" : thread.resolved ? "resolved" : "open",
        thread
      }
    ];
  });
}

function buildTourAnnotations(filePath: string, tourChapters: readonly TourChapter[]): DiffAnnotation[] {
  return tourChapters.flatMap((chapter) => {
    const anchors = chapter.diffAnchors.filter((anchor) => anchor.path === filePath);
    if (anchors.length === 0 && !chapter.files.includes(filePath)) {
      return [];
    }

    const annotationAnchors = anchors.length > 0 ? anchors : [{ path: filePath, side: "right" as const }];
    return annotationAnchors.map((anchor, index) => ({
      id: `ai:${chapter.id}:${anchor.startLine ?? "file"}:${index}`,
      kind: "ai" as const,
      title: `AI: ${chapter.title}`,
      body: chapter.summary,
      path: filePath,
      line: anchor.startLine,
      endLine: anchor.endLine,
      side: anchor.side,
      status: chapter.riskLevel
    }));
  });
}

function buildDraftAnnotations(
  filePath: string,
  draftComments: readonly (ReviewDraftComment & { id: string })[]
): DiffAnnotation[] {
  return draftComments
    .filter((comment) => comment.path === filePath)
    .map((comment) => ({
      id: `draft:${comment.id}`,
      kind: "draft" as const,
      title: "Draft review comment",
      body: comment.body,
      path: filePath,
      line: comment.line,
      side: comment.side,
      status: "pending"
    }));
}

function compareDiffAnnotations(left: DiffAnnotation, right: DiffAnnotation): number {
  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }
  if (left.kind !== right.kind) {
    return left.kind === "review" ? -1 : 1;
  }
  return left.title.localeCompare(right.title);
}
