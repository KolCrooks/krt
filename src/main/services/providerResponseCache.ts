import type { z } from "zod";
import type { ProviderId } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";

export interface ProviderCacheEntry<TPayload> {
  key: string;
  provider: ProviderId;
  scope: string;
  etag: string | null;
  headSha: string | null;
  payload: TPayload;
  updatedAt: string;
}

export class ProviderResponseCache {
  constructor(private readonly db: SqliteDatabase) {}

  get<TPayload>(
    key: string,
    schema: z.ZodType<TPayload>
  ): ProviderCacheEntry<TPayload> | null {
    const row = this.db
      .prepare(
        `SELECT cache_key, provider, scope, etag, head_sha, payload, updated_at
         FROM provider_response_cache
         WHERE cache_key = ?`
      )
      .get(key) as ProviderResponseCacheRow | undefined;

    if (!row) {
      return null;
    }

    try {
      return {
        key: row.cache_key,
        provider: row.provider,
        scope: row.scope,
        etag: row.etag,
        headSha: row.head_sha,
        payload: schema.parse(JSON.parse(row.payload)),
        updatedAt: row.updated_at
      };
    } catch {
      this.delete(key);
      return null;
    }
  }

  put<TPayload>(entry: {
    key: string;
    provider: ProviderId;
    scope: string;
    etag?: string | null;
    headSha?: string | null;
    payload: TPayload;
  }): void {
    this.db
      .prepare(
        `INSERT INTO provider_response_cache (cache_key, provider, scope, etag, head_sha, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key)
         DO UPDATE SET
           provider = excluded.provider,
           scope = excluded.scope,
           etag = excluded.etag,
           head_sha = excluded.head_sha,
           payload = excluded.payload,
           updated_at = excluded.updated_at`
      )
      .run(
        entry.key,
        entry.provider,
        entry.scope,
        entry.etag ?? null,
        entry.headSha ?? null,
        JSON.stringify(entry.payload),
        new Date().toISOString()
      );
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM provider_response_cache WHERE cache_key = ?").run(key);
  }

  invalidateScope(provider: ProviderId, scope: string): number {
    const result = this.db
      .prepare("DELETE FROM provider_response_cache WHERE provider = ? AND scope = ?")
      .run(provider, scope);
    return result.changes;
  }

  invalidatePrefix(provider: ProviderId, scopePrefix: string): number {
    const result = this.db
      .prepare("DELETE FROM provider_response_cache WHERE provider = ? AND scope LIKE ? ESCAPE '\\'")
      .run(provider, `${escapeLike(scopePrefix)}%`);
    return result.changes;
  }
}

type ProviderResponseCacheRow = {
  cache_key: string;
  provider: ProviderId;
  scope: string;
  etag: string | null;
  head_sha: string | null;
  payload: string;
  updated_at: string;
};

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (character) => `\\${character}`);
}
