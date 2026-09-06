import { and, eq } from "drizzle-orm";
import { getDb, type DbTransaction } from "../db/connection";
import { auditLog, extensions } from "../db/schema";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { LifecycleError, type LifecycleActor, type InstallationState } from "./v4/types";

export async function resolveSourceTarget(actor: LifecycleActor, installationId: string, adopt = false): Promise<{ actor: LifecycleActor; state: InstallationState | null }> {
  return getDb().transaction(async (database: DbTransaction) => {
    const repository = new DatabaseLifecycleRepository(database);
    let state = await repository.read(installationId);
    const query = database.select().from(extensions).where(eq(extensions.id, installationId));
    const [projection] = state ? await query : await query.for("update");
    if (!state) state = await repository.read(installationId);
    const historicalInstaller = !state && projection?.creatorUserId === null
      && await isHistoricalInstaller(database, installationId, projection.source, actor.principalId);
    if (state ? state.installation.ownerId !== actor.principalId : !projection || (projection.creatorUserId !== actor.principalId && !historicalInstaller)) throw new LifecycleError("forbidden", "Source target not found or access denied");
    if (!state && adopt && historicalInstaller) await database.update(extensions).set({ creatorUserId: actor.principalId }).where(eq(extensions.id, installationId));
    if (projection && projection.creatorUserId !== actor.principalId && !historicalInstaller) throw new LifecycleError("forbidden", "Source target ownership requires review");
    if (state?.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled. Import source without selecting it to create a new installation. The previous extension name remains reserved; choose a new extension name before activation.");
    if (adopt && !state) {
      await repository.create({ installation: { id: installationId, ownerId: actor.principalId, scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
      state = await repository.read(installationId);
    }
    if (adopt && projection && !state?.installation.activeReleaseId) await database.update(extensions).set({ enabled: false, grantedPermissions: { grantedAt: {} } }).where(eq(extensions.id, installationId));
    return { actor: { ...actor, scope: state?.installation.scope ?? "global" }, state };
  });
}

/** Historical main recorded installer ownership in its server-authored install audit row. */
async function isHistoricalInstaller(database: DbTransaction, installationId: string, projectionSource: string, principalId: string): Promise<boolean> {
  const source = projectionSource.split(":", 1)[0];
  if (source !== "local" && source !== "github" && source !== "git") return false;
  const rows = await database.select({ metadata: auditLog.metadata }).from(auditLog).where(and(
    eq(auditLog.target, installationId),
    eq(auditLog.userId, principalId),
    eq(auditLog.action, "ext:permission-granted"),
  ));
  return rows.some(({ metadata }) => metadata?.permission === "install"
    && metadata.source === source
    && metadata.actor === principalId
    && metadata.reason === `admin-install from source=${source}`);
}
