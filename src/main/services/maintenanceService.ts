import type {
  CacheCleanupPolicy,
  CacheCleanupResult,
  CacheCleanupTableResult,
  CacheStats,
  CacheTableStats
} from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";

type CacheTable = {
  key: keyof CacheStats;
  table: string;
  timestampColumn: string;
  sizeExpression: string;
};

const cacheTables: CacheTable[] = [
  {
    key: "prCache",
    table: "pr_cache",
    timestampColumn: "updated_at",
    sizeExpression: "LENGTH(payload)"
  },
  {
    key: "providerResponses",
    table: "provider_response_cache",
    timestampColumn: "updated_at",
    sizeExpression: "LENGTH(payload)"
  },
  {
    key: "aiTours",
    table: "ai_tours",
    timestampColumn: "generated_at",
    sizeExpression: "LENGTH(payload)"
  },
  {
    key: "performanceMeasurements",
    table: "perf_measurements",
    timestampColumn: "created_at",
    sizeExpression: "LENGTH(metadata)"
  }
];

const prPatchTable: CacheTable = {
  key: "prCache",
  table: "pr_file_patches",
  timestampColumn: "updated_at",
  sizeExpression: "LENGTH(patch)"
};

export class MaintenanceService {
  constructor(private readonly db: SqliteDatabase) {}

  getCacheStats(): CacheStats {
    const stats = {} as CacheStats;
    for (const table of cacheTables) {
      stats[table.key] = this.getTableStats(table);
    }
    stats.prCache = combineTableStats(stats.prCache, this.getTableStats(prPatchTable));
    return stats;
  }

  cleanupCaches(policy: CacheCleanupPolicy): CacheCleanupResult {
    const prMetadata = this.cleanupTable(cacheTables[0], policy);
    const prPatches = this.cleanupTable(prPatchTable, policy);
    return {
      dryRun: policy.dryRun,
      prCache: combineCleanupResults(prMetadata, prPatches),
      providerResponses: this.cleanupTable(cacheTables[1], policy),
      aiTours: this.cleanupTable(cacheTables[2], policy),
      performanceMeasurements: this.cleanupTable(cacheTables[3], policy)
    };
  }

  private getTableStats(table: CacheTable): CacheTableStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS entry_count,
                COALESCE(SUM(${table.sizeExpression}), 0) AS total_bytes,
                MIN(${table.timestampColumn}) AS oldest_updated_at,
                MAX(${table.timestampColumn}) AS newest_updated_at
         FROM ${table.table}`
      )
      .get() as {
      entry_count: number;
      total_bytes: number;
      oldest_updated_at: string | null;
      newest_updated_at: string | null;
    };

    return {
      entryCount: Number(row.entry_count),
      totalBytes: Number(row.total_bytes),
      oldestUpdatedAt: row.oldest_updated_at,
      newestUpdatedAt: row.newest_updated_at
    };
  }

  private cleanupTable(table: CacheTable, policy: CacheCleanupPolicy): CacheCleanupTableResult {
    const candidates = this.db
      .prepare(
        `SELECT rowid AS row_id,
                COALESCE(${table.sizeExpression}, 0) AS size_bytes,
                ${table.timestampColumn} AS updated_at
         FROM ${table.table}
         ORDER BY ${table.timestampColumn} ASC`
      )
      .all() as Array<{ row_id: number; size_bytes: number; updated_at: string }>;

    const cutoff = cutoffIso(policy.maxAgeDays);
    const rowIds = new Set<number>();

    for (const candidate of candidates) {
      if (candidate.updated_at < cutoff) {
        rowIds.add(candidate.row_id);
      }
    }

    const overflowCount = Math.max(0, candidates.length - policy.maxEntriesPerTable);
    for (const candidate of candidates.slice(0, overflowCount)) {
      rowIds.add(candidate.row_id);
    }

    const deleted = candidates.filter((candidate) => rowIds.has(candidate.row_id));
    if (!policy.dryRun && deleted.length > 0) {
      const placeholders = deleted.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM ${table.table} WHERE rowid IN (${placeholders})`).run(...deleted.map((row) => row.row_id));
    }

    return {
      deletedCount: deleted.length,
      freedBytes: deleted.reduce((sum, row) => sum + Number(row.size_bytes), 0)
    };
  }
}

function cutoffIso(maxAgeDays: number): string {
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
}

function combineTableStats(left: CacheTableStats, right: CacheTableStats): CacheTableStats {
  return {
    entryCount: left.entryCount + right.entryCount,
    totalBytes: left.totalBytes + right.totalBytes,
    oldestUpdatedAt: minIso(left.oldestUpdatedAt, right.oldestUpdatedAt),
    newestUpdatedAt: maxIso(left.newestUpdatedAt, right.newestUpdatedAt)
  };
}

function combineCleanupResults(
  left: CacheCleanupTableResult,
  right: CacheCleanupTableResult
): CacheCleanupTableResult {
  return {
    deletedCount: left.deletedCount + right.deletedCount,
    freedBytes: left.freedBytes + right.freedBytes
  };
}

function minIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left < right ? left : right;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}
