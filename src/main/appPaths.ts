import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AppPaths {
  root: string;
  repos: string;
  worktrees: string;
  cache: string;
  database: string;
  logs: string;
  indexes: string;
}

export function createAppPaths(userDataPath: string): AppPaths {
  const paths: AppPaths = {
    root: userDataPath,
    repos: join(userDataPath, "repos"),
    worktrees: join(userDataPath, "worktrees"),
    cache: join(userDataPath, "cache"),
    database: join(userDataPath, "cache", "db.sqlite"),
    logs: join(userDataPath, "logs"),
    indexes: join(userDataPath, "indexes")
  };

  for (const directory of [paths.root, paths.repos, paths.worktrees, paths.cache, paths.logs, paths.indexes]) {
    mkdirSync(directory, { recursive: true });
  }

  return paths;
}
