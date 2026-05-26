import type { SqliteDatabase } from "./database.js";
import type { PerformanceMeasurement } from "../../shared/schemas.js";

export class PerfService {
  constructor(private readonly db: SqliteDatabase) {}

  record(input: { name: string; durationMs: number; metadata: Record<string, unknown> }): { stored: boolean } {
    this.db
      .prepare("INSERT INTO perf_measurements (name, duration_ms, metadata, created_at) VALUES (?, ?, ?, ?)")
      .run(input.name, input.durationMs, JSON.stringify(input.metadata), new Date().toISOString());
    return { stored: true };
  }

  listRecent(limit = 20): PerformanceMeasurement[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, duration_ms, metadata, created_at
         FROM perf_measurements
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      name: string;
      duration_ms: number;
      metadata: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      durationMs: row.duration_ms,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at
    }));
  }
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
