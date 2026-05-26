import type { ChangedFile, FilePatch, PullRequestBundle, RepositoryRef } from "../../shared/schemas.js";
import { pullRequestBundleSchema } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";

export class PrCacheService {
  constructor(private readonly db: SqliteDatabase) {}

  get(repository: RepositoryRef, number: number, headSha: string): PullRequestBundle | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM pr_cache
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
      )
      .get(repository.provider, repository.owner, repository.name, number, headSha) as { payload: string } | undefined;

    return row ? this.parsePayload(row.payload, repository, number, headSha) : null;
  }

  getLatest(repository: RepositoryRef, number: number): PullRequestBundle | null {
    const row = this.db
      .prepare(
        `SELECT payload, head_sha FROM pr_cache
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(repository.provider, repository.owner, repository.name, number) as { payload: string; head_sha: string } | undefined;

    return row ? this.parsePayload(row.payload, repository, number, row.head_sha) : null;
  }

  put(bundle: PullRequestBundle): PullRequestBundle {
    const parsed = pullRequestBundleSchema.parse(bundle);
    const metadataBundle = stripBundlePatches(parsed);
    const filePatches = extractFilePatches(parsed);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `DELETE FROM pr_cache
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha != ?`
      )
      .run(
        parsed.detail.repository.provider,
        parsed.detail.repository.owner,
        parsed.detail.repository.name,
        parsed.detail.number,
        parsed.detail.headSha
      );
    this.db
      .prepare(
        `DELETE FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha != ?`
      )
      .run(
        parsed.detail.repository.provider,
        parsed.detail.repository.owner,
        parsed.detail.repository.name,
        parsed.detail.number,
        parsed.detail.headSha
      );
    this.db
      .prepare(
        `DELETE FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
      )
      .run(
        parsed.detail.repository.provider,
        parsed.detail.repository.owner,
        parsed.detail.repository.name,
        parsed.detail.number,
        parsed.detail.headSha
      );

    this.db
      .prepare(
        `INSERT INTO pr_cache (provider, owner, repo, number, head_sha, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, owner, repo, number, head_sha)
         DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(
        parsed.detail.repository.provider,
        parsed.detail.repository.owner,
        parsed.detail.repository.name,
        parsed.detail.number,
        parsed.detail.headSha,
        JSON.stringify(metadataBundle),
        now
      );

    this.storeFilePatches(parsed, filePatches, now);

    return metadataBundle;
  }

  getFilePatch(repository: RepositoryRef, number: number, path: string, headSha: string): FilePatch | null {
    const row = this.db
      .prepare(
        `SELECT patch, is_large FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ? AND path = ?`
      )
      .get(repository.provider, repository.owner, repository.name, number, headSha, path) as
      | { patch: string; is_large: number }
      | undefined;

    if (row) {
      return {
        provider: repository.provider,
        repository,
        pullNumber: number,
        path,
        patch: row.patch,
        headSha,
        isLarge: row.is_large === 1
      };
    }

    this.get(repository, number, headSha);
    const migratedRow = this.db
      .prepare(
        `SELECT patch, is_large FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ? AND path = ?`
      )
      .get(repository.provider, repository.owner, repository.name, number, headSha, path) as
      | { patch: string; is_large: number }
      | undefined;
    if (!migratedRow) {
      return null;
    }

    return {
      provider: repository.provider,
      repository,
      pullNumber: number,
      path,
      patch: migratedRow.patch,
      headSha,
      isLarge: migratedRow.is_large === 1
    };
  }

  hydrateChangedFilePatches(
    repository: RepositoryRef,
    number: number,
    headSha: string,
    files: ChangedFile[]
  ): ChangedFile[] {
    const rows = this.db
      .prepare(
        `SELECT path, patch FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
      )
      .all(repository.provider, repository.owner, repository.name, number, headSha) as Array<{ path: string; patch: string }>;
    const patchesByPath = new Map(rows.map((row) => [row.path, row.patch]));

    return files.map((file) => {
      const patch = patchesByPath.get(file.path) ?? file.patch;
      return patch ? { ...file, patch } : file;
    });
  }

  invalidate(repository: RepositoryRef, number: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM pr_cache
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ?`
      )
      .run(repository.provider, repository.owner, repository.name, number);
    this.db
      .prepare(
        `DELETE FROM pr_file_patches
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ?`
      )
      .run(repository.provider, repository.owner, repository.name, number);

    return result.changes;
  }

  private parsePayload(payload: string, repository: RepositoryRef, number: number, headSha: string): PullRequestBundle | null {
    try {
      const parsed = pullRequestBundleSchema.parse(JSON.parse(payload));
      const filePatches = extractFilePatches(parsed);
      if (filePatches.length > 0) {
        this.storeFilePatches(parsed, filePatches, new Date().toISOString());
      }
      return stripBundlePatches(parsed);
    } catch {
      this.db
        .prepare(
          `DELETE FROM pr_cache
           WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
        )
        .run(repository.provider, repository.owner, repository.name, number, headSha);
      return null;
    }
  }

  private storeFilePatches(bundle: PullRequestBundle, filePatches: FilePatch[], updatedAt: string): void {
    const insertPatch = this.db.prepare(
      `INSERT INTO pr_file_patches (provider, owner, repo, number, head_sha, path, patch, is_large, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, owner, repo, number, head_sha, path)
       DO UPDATE SET patch = excluded.patch, is_large = excluded.is_large, updated_at = excluded.updated_at`
    );
    for (const patch of filePatches) {
      insertPatch.run(
        bundle.detail.repository.provider,
        bundle.detail.repository.owner,
        bundle.detail.repository.name,
        bundle.detail.number,
        bundle.detail.headSha,
        patch.path,
        patch.patch,
        patch.isLarge ? 1 : 0,
        updatedAt
      );
    }
  }
}

export function stripChangedFilePatches(files: ChangedFile[]): ChangedFile[] {
  return files.map((file) => {
    const { patch: _patch, ...metadata } = file;
    return metadata;
  });
}

function stripBundlePatches(bundle: PullRequestBundle): PullRequestBundle {
  return {
    ...bundle,
    changedFiles: stripChangedFilePatches(bundle.changedFiles)
  };
}

function extractFilePatches(bundle: PullRequestBundle): FilePatch[] {
  return bundle.changedFiles
    .filter((file) => file.patch !== undefined)
    .map((file) => ({
      provider: bundle.detail.repository.provider,
      repository: bundle.detail.repository,
      pullNumber: bundle.detail.number,
      path: file.path,
      patch: file.patch ?? "",
      headSha: bundle.detail.headSha,
      isLarge: file.isLarge
    }));
}
