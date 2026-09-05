import { getDb } from "../db/connection";
import { getUserModifiableExtension } from "../db/queries/extensions";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { LifecycleError } from "./v4";

export type ReopenErrorCode = "NOT_FOUND_OR_NOT_MODIFIABLE" | "NO_VERIFIED_RELEASE" | "SOURCE_UNAVAILABLE";

export class ReopenError extends Error {
  constructor(readonly code: ReopenErrorCode, message: string) {
    super(message);
    this.name = "ReopenError";
  }
}

export async function reopenInstalledAsDraft(nameOrId: string, userId: string): Promise<{ installationId: string; workspaceId: string; revision: number; name: string; openUrl: string }> {
  const extension = await getUserModifiableExtension(nameOrId, userId);
  if (!extension) throw new ReopenError("NOT_FOUND_OR_NOT_MODIFIABLE", "Extension not found or not modifiable.");
  const repository = new DatabaseLifecycleRepository(getDb());
  const state = await repository.read(extension.id);
  if (state && (state.installation.ownerId !== userId || state.installation.uninstalled)) throw new ReopenError("NOT_FOUND_OR_NOT_MODIFIABLE", "Extension not found or not modifiable.");
  if (!state?.installation.activeReleaseId) throw new ReopenError("NO_VERIFIED_RELEASE", "No active immutable release is available. Import the source through the version 4 workspace flow.");
  try {
    const { getExtensionLifecycle } = await import("./extension-lifecycle-service");
    const lifecycle = await getExtensionLifecycle();
    const { workspace } = await lifecycle.createWorkspace({ principalId: userId, scope: state.installation.scope, kind: "agent" }, { installationId: extension.id, releaseId: state.installation.activeReleaseId });
    return { installationId: extension.id, workspaceId: workspace.id, revision: workspace.revision, name: extension.name, openUrl: `/extensions/author?installation=${encodeURIComponent(extension.id)}&workspace=${encodeURIComponent(workspace.id)}` };
  } catch (error) {
    if (error instanceof LifecycleError && ["unauthorized", "forbidden", "not_found", "uninstalled"].includes(error.code)) throw new ReopenError("NOT_FOUND_OR_NOT_MODIFIABLE", "Extension not found or not modifiable.");
    throw new ReopenError("SOURCE_UNAVAILABLE", "The immutable release source could not be read. No workspace was created.");
  }
}
