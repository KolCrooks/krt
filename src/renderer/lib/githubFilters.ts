// Catalog of GitHub search qualifiers usable when searching pull requests.
// Used by the search box to power slash-triggered filter autocomplete and
// value completion after a qualifier's colon.

export interface GithubFilterValue {
  value: string;
  description?: string;
}

export interface GithubFilter {
  key: string;
  description: string;
  // Enumerated values for value autocomplete. Absent for free-text qualifiers
  // (usernames, branches, dates, numbers).
  values?: GithubFilterValue[];
  // Hint shown after the colon for free-text qualifiers.
  valueHint?: string;
}

export const GITHUB_PR_FILTERS: readonly GithubFilter[] = [
  {
    key: "is",
    description: "Match state or visibility",
    values: [
      { value: "open", description: "Open" },
      { value: "closed", description: "Closed" },
      { value: "merged", description: "Merged" },
      { value: "draft", description: "Draft" },
      { value: "public", description: "In public repos" },
      { value: "private", description: "In private repos" },
      { value: "locked", description: "Conversation locked" },
      { value: "unlocked", description: "Conversation unlocked" }
    ]
  },
  {
    key: "state",
    description: "Open or closed",
    values: [
      { value: "open", description: "Open" },
      { value: "closed", description: "Closed" }
    ]
  },
  {
    key: "review",
    description: "Review status",
    values: [
      { value: "none", description: "No reviews" },
      { value: "required", description: "Review required" },
      { value: "approved", description: "Approved" },
      { value: "changes_requested", description: "Changes requested" }
    ]
  },
  {
    key: "status",
    description: "Commit / CI status",
    values: [
      { value: "pending", description: "Pending" },
      { value: "success", description: "Success" },
      { value: "failure", description: "Failure" }
    ]
  },
  {
    key: "draft",
    description: "Draft or ready",
    values: [
      { value: "true", description: "Draft only" },
      { value: "false", description: "Ready only" }
    ]
  },
  {
    key: "archived",
    description: "In archived repos",
    values: [
      { value: "true", description: "Archived" },
      { value: "false", description: "Not archived" }
    ]
  },
  {
    key: "linked",
    description: "Linked references",
    values: [
      { value: "issue", description: "Linked to an issue" },
      { value: "pr", description: "Linked to a PR" }
    ]
  },
  {
    key: "no",
    description: "Missing metadata",
    values: [
      { value: "label", description: "No label" },
      { value: "milestone", description: "No milestone" },
      { value: "assignee", description: "No assignee" },
      { value: "project", description: "No project" }
    ]
  },
  {
    key: "in",
    description: "Restrict text match",
    values: [
      { value: "title", description: "Title only" },
      { value: "body", description: "Body only" },
      { value: "comments", description: "Comments only" }
    ]
  },
  {
    key: "sort",
    description: "Sort results",
    values: [
      { value: "updated-desc", description: "Recently updated" },
      { value: "updated-asc", description: "Least recently updated" },
      { value: "created-desc", description: "Newest" },
      { value: "created-asc", description: "Oldest" },
      { value: "comments-desc", description: "Most commented" },
      { value: "comments-asc", description: "Least commented" },
      { value: "reactions-desc", description: "Most reactions" },
      { value: "interactions-desc", description: "Most interactions" }
    ]
  },
  { key: "author", description: "Opened by user", valueHint: "username" },
  { key: "assignee", description: "Assigned to user", valueHint: "username" },
  { key: "mentions", description: "Mentions user", valueHint: "username" },
  { key: "commenter", description: "Commented on by user", valueHint: "username" },
  { key: "involves", description: "User is involved", valueHint: "username" },
  { key: "review-requested", description: "Review requested from user", valueHint: "username" },
  { key: "team-review-requested", description: "Review requested from team", valueHint: "org/team" },
  { key: "reviewed-by", description: "Reviewed by user", valueHint: "username" },
  { key: "user", description: "In a user's repos", valueHint: "username" },
  { key: "org", description: "In an org's repos", valueHint: "org" },
  { key: "repo", description: "In a specific repo", valueHint: "owner/repo" },
  { key: "label", description: "Has label", valueHint: "name" },
  { key: "milestone", description: "In milestone", valueHint: "name" },
  { key: "project", description: "On project board", valueHint: "owner/number" },
  { key: "head", description: "Head branch", valueHint: "branch" },
  { key: "base", description: "Base branch", valueHint: "branch" },
  { key: "language", description: "Repo language", valueHint: "language" },
  { key: "comments", description: "Comment count", valueHint: ">n, n..m" },
  { key: "interactions", description: "Reactions + comments", valueHint: ">n, n..m" },
  { key: "reactions", description: "Reaction count", valueHint: ">n, n..m" },
  { key: "created", description: "Created date", valueHint: ">YYYY-MM-DD" },
  { key: "updated", description: "Updated date", valueHint: ">YYYY-MM-DD" },
  { key: "merged", description: "Merged date", valueHint: ">YYYY-MM-DD" },
  { key: "closed", description: "Closed date", valueHint: ">YYYY-MM-DD" }
];

const FILTERS_BY_KEY = new Map(GITHUB_PR_FILTERS.map((filter) => [filter.key, filter]));

export function getGithubFilter(key: string): GithubFilter | undefined {
  return FILTERS_BY_KEY.get(key.toLowerCase());
}

export interface FilterSuggestion {
  // Stable identity for list keys and highlight tracking.
  id: string;
  // Primary text shown in the menu.
  label: string;
  description?: string;
  // The token text that replaces the active token when chosen.
  insert: string;
  // When true the menu stays open after applying (e.g. picking a key that has
  // enumerated values, so the user can immediately pick one).
  keepOpen?: boolean;
}

export interface ActiveToken {
  // Start index of the active token within the full query string.
  start: number;
  // The token text from the last whitespace up to the caret.
  text: string;
}

export function activeTokenAt(value: string, caret: number): ActiveToken {
  const before = value.slice(0, caret);
  const lastSpace = before.lastIndexOf(" ");
  const lastNewline = before.lastIndexOf("\n");
  const start = Math.max(lastSpace, lastNewline) + 1;
  return { start, text: before.slice(start) };
}

// Builds suggestions for the active token. Returns key suggestions when the
// token begins with `/`, and value suggestions once a `key:` has been typed.
export function suggestFilters(token: string, limit = 8): FilterSuggestion[] {
  const colon = token.indexOf(":");
  if (colon !== -1) {
    const key = token.slice(0, colon).replace(/^\//, "");
    const filter = getGithubFilter(key);
    if (!filter?.values) {
      return [];
    }
    const partial = token.slice(colon + 1).toLowerCase();
    return filter.values
      .filter((entry) => entry.value.toLowerCase().includes(partial))
      .slice(0, limit)
      .map((entry) => ({
        id: `${filter.key}:${entry.value}`,
        label: entry.value,
        description: entry.description,
        insert: `${filter.key}:${entry.value} `
      }));
  }

  if (!token.startsWith("/")) {
    return [];
  }

  const partial = token.slice(1).toLowerCase();
  return GITHUB_PR_FILTERS.filter((filter) => filter.key.includes(partial))
    .slice(0, limit)
    .map((filter) => ({
      id: filter.key,
      label: `${filter.key}:`,
      description: filter.description,
      insert: `${filter.key}:`,
      keepOpen: Boolean(filter.values)
    }));
}
