import { createHash } from "node:crypto";
import type {
  ActivityEvent,
  AppSettings,
  ChangedFile,
  CheckRun,
  PullRequestDetail,
  RepositoryRef,
  ReviewThread,
  ReviewTour
} from "../../shared/schemas.js";
import { reviewTourSchema } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";
import type { Keychain } from "./keychain.js";
import { AppError } from "../errors.js";
import { getProviderAdapter, modelLikelyLacksToolSupport } from "./ai/adapters.js";
import { createReviewToolset, type ReviewRepoAccess } from "./ai/reviewTools.js";
import { assertNotAborted, runReviewAgent } from "./ai/agentRuntime.js";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "./ai/reviewPrompt.js";
import { summarizeChangeMap, type ChangeMap } from "./ai/changeMap.js";
import type { ChangeMapService } from "./changeMapService.js";

// Bump when the agent prompt, toolset, or tour schema changes in a way that
// should invalidate previously cached tours. Folded into the cache key so a
// stale tour (incl. old single-shot tours, whose settings_hash is empty) is
// treated as a miss and regenerated.
const AGENT_VERSION = "agent-1";

const GENERATION_ATTEMPTS = 2;

interface GenerateTourInput {
  pullRequest: PullRequestDetail;
  changedFiles: ChangedFile[];
  timeline: ActivityEvent[];
  reviewThreads: ReviewThread[];
  checks: CheckRun[];
  force?: boolean;
}

export interface AiGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    phase: string;
    message: string;
    percent: number;
    tour?: ReviewTour;
    activity?: { kind: "think" | "say" | "tool" | "result"; text: string };
  }) => void;
  onStats?: (stats: { turns: number; outputTokens: number; stoppedReason: string }) => void;
}

export class AiService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly keychain: Keychain,
    private readonly getSettings: () => AppSettings,
    private readonly repos: ReviewRepoAccess,
    private readonly changeMapService?: ChangeMapService
  ) {}

  getCachedTour(repository: RepositoryRef, number: number, headSha: string): ReviewTour | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM ai_tours
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ? AND settings_hash = ?`
      )
      .get(repository.provider, repository.owner, repository.name, number, headSha, this.settingsHash(this.getSettings())) as
      | { payload: string }
      | undefined;

    if (!row) {
      return null;
    }
    try {
      return reviewTourSchema.parse(JSON.parse(row.payload));
    } catch {
      // A corrupted or schema-incompatible cache row is a miss, not a failure —
      // fall through to regeneration rather than throwing.
      return null;
    }
  }

  async generateTour(input: GenerateTourInput, options: AiGenerationOptions = {}): Promise<ReviewTour> {
    assertNotAborted(options.signal);
    const settings = this.getSettings();
    const cached = input.force
      ? null
      : this.getCachedTour(input.pullRequest.repository, input.pullRequest.number, input.pullRequest.headSha);
    if (cached) {
      options.onProgress?.({ phase: "cache", message: "Loaded AI tour from cache", percent: 100 });
      return cached;
    }

    if (!settings.ai.enabled || settings.ai.provider === "disabled") {
      throw new AppError(
        "ai_disabled",
        "AI review is turned off. Enable a provider in Settings → AI Review to generate a tour."
      );
    }

    const adapter = getProviderAdapter(settings.ai.provider);
    if (!adapter || !adapter.supportsTools) {
      throw new AppError(
        "ai_tools_unsupported",
        `The ${settings.ai.provider} provider cannot run AI review because it does not support tool calling.`
      );
    }
    if (modelLikelyLacksToolSupport(settings.ai.provider, settings.ai.model)) {
      throw new AppError(
        "ai_tools_unsupported",
        `The model "${settings.ai.model}" does not support tool calling, which AI review requires. Choose a tool-capable model in Settings → AI Review.`
      );
    }

    options.onProgress?.({ phase: "prepare", message: "Preparing the review agent", percent: 12 });
    assertNotAborted(options.signal);

    const apiKey = await this.resolveApiKey(settings);
    if (settings.ai.provider !== "ollama" && settings.ai.provider !== "bedrock" && !apiKey) {
      throw new AppError(
        "ai_no_key",
        `No API key is configured for ${settings.ai.provider}. Add one in Settings → AI Review before generating a tour.`
      );
    }

    const repository = input.pullRequest.repository;
    const headSha = input.pullRequest.headSha;
    if (!this.repos.getWorktreePath(repository, headSha)) {
      throw new AppError(
        "ai_requires_worktree",
        "AI review reads the checked-out code, so it needs this pull request checked out in managed mode. Check out the PR, then generate the tour."
      );
    }

    // Phase 0: deterministic blast-radius analysis. Best-effort — if LSP is
    // unavailable or slow, the agent still grounds itself via search_text.
    let changeMap: ChangeMap | undefined;
    if (this.changeMapService) {
      options.onProgress?.({ phase: "analyze", message: "Analyzing change impact…", percent: 18 });
      try {
        changeMap = await this.changeMapService.build(repository, headSha, input.changedFiles, { signal: options.signal });
      } catch {
        changeMap = undefined;
      }
      assertNotAborted(options.signal);
    }

    const tour = await this.runAgentWithRetries(adapter, settings, apiKey, input, changeMap, options);
    assertNotAborted(options.signal);

    options.onProgress?.({ phase: "persist", message: "Persisting AI tour", percent: 94 });
    this.persistTour(tour, settings);
    return tour;
  }

  private async runAgentWithRetries(
    adapter: ReturnType<typeof getProviderAdapter>,
    settings: AppSettings,
    apiKey: string | null,
    input: GenerateTourInput,
    changeMap: ChangeMap | undefined,
    options: AiGenerationOptions
  ): Promise<ReviewTour> {
    if (!adapter) {
      throw new AppError("ai_not_configured", "No AI provider adapter is available.");
    }
    const model = settings.ai.model || settings.ai.provider;
    const generatedAt = new Date().toISOString();
    const system = buildReviewSystemPrompt();
    const changeMapSummary = changeMap ? summarizeChangeMap(changeMap) : "";
    const userMessage = changeMapSummary
      ? `${buildReviewUserMessage(input)}\n\n${changeMapSummary}`
      : buildReviewUserMessage(input);

    let lastError: unknown;
    for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(options.signal);
      if (attempt > 1) {
        options.onProgress?.({
          phase: "retry",
          message: `Retrying the review agent (attempt ${attempt} of ${GENERATION_ATTEMPTS})…`,
          percent: 16
        });
      }
      // Progress only moves forward: each activity nudges it, each new chapter
      // jumps it, and neither can pull it backwards.
      let percent = 22;
      const bump = (target: number): number => {
        percent = Math.max(percent, Math.min(90, target));
        return percent;
      };
      const toolset = createReviewToolset({
        repos: this.repos,
        repository: input.pullRequest.repository,
        pullProvider: input.pullRequest.provider,
        pullNumber: input.pullRequest.number,
        headSha: input.pullRequest.headSha,
        model,
        generatedAt,
        changedFiles: input.changedFiles,
        changeMap,
        signal: options.signal,
        onUpdate: (partial) =>
          options.onProgress?.({
            phase: "stream",
            message: `Writing the tour — ${partial.chapters.length} chapter${partial.chapters.length === 1 ? "" : "s"} so far`,
            percent: bump(30 + partial.chapters.length * 7),
            tour: partial
          })
      });

      try {
        options.onProgress?.({ phase: "generate", message: "Exploring the change…", percent: bump(22) });
        const result = await runReviewAgent({
          adapter,
          settings,
          apiKey,
          system,
          userMessage,
          toolset,
          signal: options.signal,
          onActivity: ({ kind, text }) =>
            options.onProgress?.({
              phase: "activity",
              message: text.length > 160 ? `${text.slice(0, 160)}…` : text,
              percent: bump(percent + 1.2),
              activity: { kind, text }
            })
        });
        const tour = toolset.build();
        if (tour.chapters.length === 0) {
          throw new AppError("ai_invalid_tour", "The review agent did not produce any chapters.", { retryable: true });
        }
        options.onStats?.({ turns: result.turns, outputTokens: result.outputTokens, stoppedReason: result.stoppedReason });
        return tour;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof AppError && !error.retryable)) {
          throw error;
        }
        lastError = error;
        if (attempt < GENERATION_ATTEMPTS) {
          await sleep(250 * attempt);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AppError("ai_invalid_tour", "The review agent did not produce a valid tour after several attempts.");
  }

  private persistTour(tour: ReviewTour, settings: AppSettings): void {
    this.db
      .prepare(
        `INSERT INTO ai_tours (provider, owner, repo, number, head_sha, settings_hash, payload, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, owner, repo, number, head_sha)
         DO UPDATE SET settings_hash = excluded.settings_hash, payload = excluded.payload, generated_at = excluded.generated_at`
      )
      .run(
        tour.repository.provider,
        tour.repository.owner,
        tour.repository.name,
        tour.pullNumber,
        tour.headSha,
        this.settingsHash(settings),
        JSON.stringify(tour),
        tour.generatedAt
      );
  }

  private settingsHash(settings: AppSettings): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: AGENT_VERSION,
          provider: settings.ai.provider,
          model: settings.ai.model,
          thinkingEnabled: settings.ai.thinkingEnabled
        })
      )
      .digest("hex")
      .slice(0, 16);
  }

  async hasConfiguredApiKey(): Promise<boolean> {
    const settings = this.getSettings();
    if (settings.ai.provider === "ollama") {
      return true;
    }
    return Boolean(await this.resolveApiKey(settings));
  }

  private async resolveApiKey(settings: AppSettings): Promise<string | null> {
    switch (settings.ai.keyProvider) {
      case "environment":
        return process.env.AI_API_KEY ?? null;
      case "command":
        return this.keychain.getCommandSecret(settings.ai.keyCommand);
      case "keychain":
      default:
        return await this.keychain.getSecret("AI_API_KEY");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
