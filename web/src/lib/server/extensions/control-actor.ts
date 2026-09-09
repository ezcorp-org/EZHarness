import { getDb } from "$server/db/connection";
import { DatabaseLifecycleRepository } from "$server/db/queries/extension-releases";
import { LifecycleError, type LifecycleActor } from "$server/extensions/v4/types";

export async function resolveControlActor(user: { id: string; role: string }, kind: LifecycleActor["kind"], installationId?: string): Promise<LifecycleActor> {
  const actor: LifecycleActor = { principalId: user.id, scope: "global", kind };
  if (!installationId) return actor;
  const state = await new DatabaseLifecycleRepository(getDb()).read(installationId);
  if (!state || (state.installation.ownerId !== user.id && user.role !== "admin")) throw new LifecycleError("not_found", "Installation not found.");
  return { ...actor, scope: state.installation.scope };
}
