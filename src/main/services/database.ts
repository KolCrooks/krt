import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

type SqliteValue = string | number | bigint | Buffer | null;

export interface SqliteStatement {
  get(...params: SqliteValue[]): unknown;
  all(...params: SqliteValue[]): unknown[];
  run(...params: SqliteValue[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): void;
  close(): void;
}

class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  pragma(sql: string): void {
    this.db.exec(`PRAGMA ${sql}`);
  }

  close(): void {
    this.db.close();
  }
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  get(...params: SqliteValue[]): unknown {
    return this.statement.get(...params);
  }

  all(...params: SqliteValue[]): unknown[] {
    return this.statement.all(...params);
  }

  run(...params: SqliteValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid
    };
  }
}

export function openDatabase(filename: string): SqliteDatabase {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const db = new NodeSqliteDatabase(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_cache (
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, number, head_sha)
    );

    CREATE TABLE IF NOT EXISTS pr_file_patches (
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      path TEXT NOT NULL,
      patch TEXT NOT NULL,
      is_large INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, number, head_sha, path)
    );

    CREATE INDEX IF NOT EXISTS idx_pr_file_patches_pr
      ON pr_file_patches(provider, owner, repo, number, head_sha);

    CREATE TABLE IF NOT EXISTS provider_response_cache (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      scope TEXT NOT NULL,
      etag TEXT,
      head_sha TEXT,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_provider_response_cache_scope
      ON provider_response_cache(provider, scope);

    CREATE TABLE IF NOT EXISTS ai_tours (
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      payload TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (provider, owner, repo, number, head_sha)
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      provider TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      head_ref TEXT,
      base_ref TEXT,
      worktree_path TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, owner, repo, number, head_sha)
    );

    CREATE TABLE IF NOT EXISTS perf_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "worktrees", "head_ref", "TEXT");
  ensureColumn(db, "worktrees", "base_ref", "TEXT");
}

function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
