import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { krtClient } from "../api/client.js";
import type { RepositoryRef } from "../../shared/schemas.js";

interface EnsureLspSessionOptions {
  enabled: boolean;
  repository: RepositoryRef | null | undefined;
  headSha: string | null | undefined;
  paths?: string[];
}

const startRequests = new Map<string, Promise<unknown>>();

export function useEnsureLspSession({ enabled, repository, headSha, paths = [] }: EnsureLspSessionOptions): void {
  const queryClient = useQueryClient();
  const repositoryProvider = repository?.provider;
  const repositoryOwner = repository?.owner;
  const repositoryName = repository?.name;
  const repositoryFullName = repository?.fullName;
  const repositoryKey = `${repositoryProvider}:${repositoryFullName}`;
  const pathsKey = paths.join("\0");

  useEffect(() => {
    if (!enabled || !repositoryProvider || !repositoryOwner || !repositoryName || !repositoryFullName || !headSha) {
      return;
    }

    const scopedPaths = pathsKey ? pathsKey.split("\0").filter(Boolean) : [];
    const key = `${repositoryKey}:${headSha}:${pathsKey}`;
    const repositoryRef: RepositoryRef = {
      provider: repositoryProvider,
      owner: repositoryOwner,
      name: repositoryName,
      fullName: repositoryFullName
    };
    let startRequest = startRequests.get(key);
    if (!startRequest) {
      startRequest = krtClient.lsp.startForWorktree({
        repository: repositoryRef,
        headSha,
        ...(scopedPaths.length > 0 ? { paths: scopedPaths } : {})
      });
      startRequests.set(key, startRequest);
      void startRequest
        .finally(() => {
          if (startRequests.get(key) === startRequest) {
            startRequests.delete(key);
          }
        })
        .catch(() => undefined);
    }

    void startRequest
      .catch(() => undefined)
      .then(async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["lsp-session", repositoryFullName, headSha] }),
          queryClient.invalidateQueries({ queryKey: ["lsp-diagnostics", repositoryFullName, headSha] })
        ]);
      });
  }, [
    enabled,
    headSha,
    pathsKey,
    queryClient,
    repositoryFullName,
    repositoryKey,
    repositoryName,
    repositoryOwner,
    repositoryProvider
  ]);
}
