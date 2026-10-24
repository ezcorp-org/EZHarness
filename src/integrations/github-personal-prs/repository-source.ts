import { randomUUID } from "node:crypto";
import { checkRepository, withUserToken } from "../github-user/broker";
import { githubApi } from "../github-user/transport";
import { fetchApprovedBase } from "./github-source";

/** Both workspace adapters use one host-only account and source fetch path. */
export async function approvedRepositorySource(userId: string, repositoryId: number, baseRef: string, operationId: string = randomUUID()) {
  const repository = await checkRepository({ userId, repositoryId });
  if (repository.status !== "ready" || !repository.repository) return { blocked: repository.status } as const;
  const source = await withUserToken({ userId, repositoryId, kind: "import", operationId }, token =>
    fetchApprovedBase({ repositoryId, fullName: repository.repository!.fullName, baseRef, token },
      (path, credential) => githubApi(credential, path)));
  return { source } as const;
}
