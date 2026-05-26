// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../../src/main/services/database.js";
import { ProviderResponseCache } from "../../src/main/services/providerResponseCache.js";

const payloadSchema = z.object({
  id: z.string(),
  headSha: z.string()
});

describe("ProviderResponseCache", () => {
  it("stores normalized provider payloads with ETag and head SHA metadata", () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));

    cache.put({
      key: "repo:kol/repo:pr:12:detail",
      provider: "github",
      scope: "repo:kol/repo:pr:12",
      etag: "\"abc\"",
      headSha: "head-1",
      payload: { id: "12", headSha: "head-1" }
    });

    expect(cache.get("repo:kol/repo:pr:12:detail", payloadSchema)).toMatchObject({
      etag: "\"abc\"",
      headSha: "head-1",
      payload: { id: "12", headSha: "head-1" }
    });
  });

  it("evicts corrupt payloads instead of returning unvalidated data", () => {
    const db = openDatabase(":memory:");
    const cache = new ProviderResponseCache(db);

    db.prepare(
      `INSERT INTO provider_response_cache (cache_key, provider, scope, etag, head_sha, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("bad", "github", "repo:kol/repo:pr:12", null, null, "{", new Date().toISOString());

    expect(cache.get("bad", payloadSchema)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_response_cache").get()).toEqual({ count: 0 });
  });

  it("invalidates provider response scopes by prefix", () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    cache.put({
      key: "repo:kol/repo:pr:12:detail",
      provider: "github",
      scope: "repo:kol/repo:pr:12",
      payload: { id: "12", headSha: "head-1" }
    });
    cache.put({
      key: "repo:kol/repo:pr:13:detail",
      provider: "github",
      scope: "repo:kol/repo:pr:13",
      payload: { id: "13", headSha: "head-2" }
    });

    expect(cache.invalidatePrefix("github", "repo:kol/repo:pr:12")).toBe(1);
    expect(cache.get("repo:kol/repo:pr:12:detail", payloadSchema)).toBeNull();
    expect(cache.get("repo:kol/repo:pr:13:detail", payloadSchema)?.payload.id).toBe("13");
  });
});
