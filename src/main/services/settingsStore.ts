import { DEFAULT_AI_MODELS, STALE_DEFAULT_AI_MODELS } from "../../shared/aiModels.js";
import { appSettingsSchema, defaultAppSettings, type AppSettings } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";

export type SettingsUpdate = Partial<
  Omit<AppSettings, "appearance" | "data" | "ai" | "github" | "updates" | "extensions" | "pinnedRepos">
> & {
  appearance?: Partial<AppSettings["appearance"]>;
  data?: Partial<AppSettings["data"]>;
  ai?: Partial<AppSettings["ai"]>;
  github?: Partial<AppSettings["github"]>;
  updates?: Partial<AppSettings["updates"]>;
  extensions?: Partial<AppSettings["extensions"]>;
  pinnedRepos?: AppSettings["pinnedRepos"];
};

export class SettingsStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(): AppSettings {
    const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get("settings") as { value: string } | undefined;
    if (!row) {
      return defaultAppSettings;
    }

    return migrateSettings(appSettingsSchema.parse({
      ...defaultAppSettings,
      ...JSON.parse(row.value)
    }));
  }

  update(partial: SettingsUpdate): AppSettings {
    const current = this.get();
    const merged = appSettingsSchema.parse({
      ...current,
      ...partial,
      appearance: { ...current.appearance, ...partial.appearance },
      data: { ...current.data, ...partial.data },
      ai: { ...current.ai, ...partial.ai },
      github: { ...current.github, ...partial.github },
      updates: { ...current.updates, ...partial.updates },
      extensions: { ...current.extensions, ...partial.extensions },
      pinnedRepos: partial.pinnedRepos ?? current.pinnedRepos
    });

    this.db
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run("settings", JSON.stringify(merged), new Date().toISOString());

    return merged;
  }
}

function migrateSettings(settings: AppSettings): AppSettings {
  const staleModels = STALE_DEFAULT_AI_MODELS[settings.ai.provider] ?? [];
  if (!staleModels.includes(settings.ai.model)) {
    return settings;
  }

  return {
    ...settings,
    ai: {
      ...settings.ai,
      model: DEFAULT_AI_MODELS[settings.ai.provider]
    }
  };
}
