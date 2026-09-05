import { eq } from "drizzle-orm";
import { getDb, type DbTransaction } from "../db/connection";
import { extensions } from "../db/schema";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { LifecycleError, type LifecycleActor, type InstallationState } from "./v4/types";

export async function resolveSourceTarget(actor: LifecycleActor, installationId: string, adopt = false): Promise<{ actor: LifecycleActor; state: InstallationState | null }> {
  return getDb().transaction(async (database: DbTransaction) => {
    const repository = new DatabaseLifecycleRepository(database);
    let state = await repository.read(installationId);
    const query = database.select().from(extensions).where(eq(extensions.id, installationId));
    const [projection] = state ? await query : await query.for("update");
    if (!state) state = await repository.read(installationId);
    if (state ? state.installation.ownerId !== actor.principalId || state.installation.uninstalled : !projection || projection.creatorUserId !== actor.principalId) throw new LifecycleError("forbidden", "Source target not found or access denied");
    if (projection && projection.creatorUserId !== actor.principalId) throw new LifecycleError("forbidden", "Source target ownership requires review");
    if (adopt && !state) {
      await repository.create({ installation: { id: installationId, ownerId: actor.principalId, scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
      state = await repository.read(installationId);
    }
    if (adopt && projection && !state?.installation.activeReleaseId) await database.update(extensions).set({ enabled: false, grantedPermissions: { grantedAt: {} } }).where(eq(extensions.id, installationId));
    return { actor: { ...actor, scope: state?.installation.scope ?? "global" }, state };
  });
}
