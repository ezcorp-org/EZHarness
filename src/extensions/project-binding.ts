import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import type { MigrationDb } from "../db/migrations/types";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { LifecycleError, type InstallationRecord, type LifecycleActor } from "./v4/types";

export interface ExtensionProjectBinding {
  id: string;
  projectId: string;
  ownerId: string;
  releaseId: string;
  generation: number;
  approvedAt: string;
  writePaths: string[];
}

export async function getExtensionProjectBinding(installationId: string): Promise<ExtensionProjectBinding | null> {
  const rows = releaseRows<{ binding: string; installation: string }>(await getDb().execute(sql`SELECT b.payload AS binding, i.payload AS installation FROM extension_project_bindings b JOIN extension_release_installations i ON i.id = b.installation_id WHERE i.id = ${installationId}`));
  const row = rows[0];
  if (!row) return null;
  const binding: ExtensionProjectBinding = JSON.parse(row.binding);
  const installation: InstallationRecord = JSON.parse(row.installation);
  if (!installation.enabled || installation.uninstalled || installation.activeReleaseId !== binding.releaseId || installation.generation !== binding.generation || installation.ownerId !== binding.ownerId) return null;
  return binding;
}

export async function setExtensionProjectBinding(actor: LifecycleActor, input: { installationId: string; projectId: string | null; releaseId: string; generation: number; writePaths?: string[] }): Promise<ExtensionProjectBinding | null> {
  if (actor.kind !== "human") throw new LifecycleError("human_required", "A human session must approve project access.");
  if (!input.installationId || !input.releaseId || !Number.isSafeInteger(input.generation) || input.generation < 0 || (input.projectId !== null && (typeof input.projectId !== "string" || !input.projectId || input.projectId.length > 128))) throw new LifecycleError("invalid_input", "Provide the exact release, generation and project.");
  const writePaths = input.writePaths ?? [];
  if (!Array.isArray(writePaths) || writePaths.length > 100 || writePaths.some(path => typeof path !== "string" || !path || path.length > 4096 || (/[\\*?]/.test(path) || /\p{Cc}/u.test(path)) || path.startsWith("/") || path.replace(/\/$/, "").split("/").some(part => !part || part === "." || part === ".."))) throw new LifecycleError("invalid_input", "Write scopes must be safe relative files or directory prefixes ending in /.");
  const state = await (await getExtensionLifecycle()).inspect(actor, input.installationId);
  if (state.installation.ownerId !== actor.principalId) throw new LifecycleError("permission_denied", "Only the installation owner can bind a project.");
  const { getUserById } = await import("../db/queries/users");
  const { getProject } = await import("../db/queries/projects");
  const { checkProjectRole } = await import("../auth/middleware");
  const user = await getUserById(actor.principalId);
  if (user?.status !== "active") throw new LifecycleError("permission_denied", "An active user is required.");
  if (input.projectId !== null) {
    if (await checkProjectRole({ user }, input.projectId, "member") instanceof Response) throw new LifecycleError("permission_denied", "Project membership is required.");
    if (!(await getProject(input.projectId))?.path) throw new LifecycleError("project_required", "A local project is required.");
  }
  return getDb().transaction(async (transaction: MigrationDb) => {
    const rows = releaseRows<{ payload: string }>(await transaction.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${input.installationId} FOR UPDATE`));
    const installation: InstallationRecord | undefined = rows[0] ? JSON.parse(rows[0].payload) : undefined;
    if (!installation || installation.ownerId !== actor.principalId || !installation.enabled || installation.uninstalled || installation.activeReleaseId !== input.releaseId || installation.generation !== input.generation) throw new LifecycleError("stale_release", "The active release changed. Review its project access again.");
    await transaction.execute(sql`INSERT INTO extension_project_binding_events (id, installation_id, payload) VALUES (${crypto.randomUUID()}, ${input.installationId}, ${JSON.stringify({ ...input, approvedBy: actor.principalId, at: new Date().toISOString() })})`);
    if (input.projectId === null) {
      await transaction.execute(sql`DELETE FROM extension_project_bindings WHERE installation_id = ${input.installationId}`);
      return null;
    }
    const binding: ExtensionProjectBinding = { id: crypto.randomUUID(), projectId: input.projectId, ownerId: actor.principalId, releaseId: input.releaseId, generation: input.generation, approvedAt: new Date().toISOString(), writePaths: [...new Set(writePaths)].sort() };
    await transaction.execute(sql`INSERT INTO extension_project_bindings (installation_id, payload) VALUES (${input.installationId}, ${JSON.stringify(binding)}) ON CONFLICT (installation_id) DO UPDATE SET payload = EXCLUDED.payload`);
    return binding;
  });
}
