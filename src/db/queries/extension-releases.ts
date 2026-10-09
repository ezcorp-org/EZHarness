import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import { LifecycleError, type InstallationRecord, type InstallationState, type LifecycleRepository, type LifecycleActor } from "../../extensions/v4/types";
import { insertTransactionalAuditEntry } from "./audit-log";
import { compensatedCleanupPredicate } from "../../infrastructure/incus-fenced-cleanup-policy";
import { digestObject } from "../../extensions/v4/blobs";

export interface ReleaseDatabase extends MigrationDb {
  transaction<Result>(work: (transaction: MigrationDb) => Promise<Result>): Promise<Result>;
}

export function releaseRows<Result>(result: unknown): Result[] {
  if (Array.isArray(result)) return result as Result[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows as Result[];
  throw new LifecycleError("database_result", "The database returned an unsupported result.");
}

/** The installation lock fences admission while an active provider is retired. */
export async function hasUnfinishedProviderSandboxes(database: MigrationDb, installationId: string, connectionId?: string): Promise<boolean> {
  const compensated = compensatedCleanupPredicate({ id: sql`operation.id`, bindingId: sql`operation.binding_id`, generation: sql`operation.generation`, state: sql`operation.state`, payloadHash: sql`operation.payload_hash`, providerOperationId: sql`operation.provider_operation_id` });
  const connection = connectionId === undefined ? sql`` : sql`AND binding.connection_id = ${connectionId}`;
  const rows = releaseRows(await database.execute(sql`SELECT binding.id FROM sandbox_bindings AS binding
    WHERE binding.provider_installation_id = ${installationId} ${connection}
    AND (binding.tombstoned_at IS NULL OR binding.cleanup_confirmed_at IS NULL
      OR binding.desired_state <> 'ABSENT' OR binding.observed_state <> 'ABSENT'
      OR EXISTS (SELECT 1 FROM provider_sandbox_operations AS operation WHERE operation.binding_id = binding.id
        AND operation.state IN ('JOURNALED', 'DISPATCHING', 'PROVIDER_PENDING', 'OUTCOME_UNKNOWN') AND NOT (${compensated}))
      OR EXISTS (SELECT 1 FROM sandbox_reservations AS reservation WHERE reservation.binding_id = binding.id
        AND (reservation.compute_state <> 'RELEASED' OR reservation.disk_state <> 'RELEASED')))
    LIMIT 1 FOR SHARE`));
  return rows.length > 0;
}

async function assertProviderReleaseChangeDrained(database: MigrationDb, state: InstallationState, nextReleaseId: string | null): Promise<void> {
  const previous = state.installation.activeReleaseId;
  if (previous === nextReleaseId || !previous || !state.releases[previous]?.manifest.sandboxProviders?.length) return;
  if (await hasUnfinishedProviderSandboxes(database, state.installation.id)) {
    throw new LifecycleError("provider_not_drained", "Drain all provider sandboxes before changing the active release.");
  }
}

const recordKinds = ["workspaces", "revisions", "operations", "releases", "approvals"] as const;

async function readState(db: MigrationDb, installationId: string, lock: "update" | "share"): Promise<InstallationState | null> {
  const lockClause = lock === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`;
  const installationRows = releaseRows<{ payload: string }>(await db.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId} ${lockClause}`));
  if (!installationRows[0]) return null;
  const state: InstallationState = { installation: JSON.parse(installationRows[0].payload), workspaces: {}, revisions: {}, operations: {}, releases: {}, approvals: {} };
  const records = releaseRows<{ kind: typeof recordKinds[number]; id: string; payload: string }>(await db.execute(sql`SELECT kind, id, payload FROM extension_release_records WHERE installation_id = ${installationId}`));
  for (const record of records) Object.defineProperty(state[record.kind], record.id, { value: JSON.parse(record.payload), enumerable: true, writable: true, configurable: true });
  return state;
}

async function writeRecords(db: MigrationDb, state: InstallationState, original?: InstallationState): Promise<void> {
  for (const kind of recordKinds) {
    for (const [id, record] of Object.entries(state[kind])) {
      const previous = original?.[kind][id];
      const payload = JSON.stringify(record);
      if (previous && JSON.stringify(previous) === payload) continue;
      if (previous && (kind === "releases" || kind === "revisions")) throw new LifecycleError("immutable_release", "Verified releases and source revisions cannot be changed.");
      await db.execute(sql`INSERT INTO extension_release_records (installation_id, kind, id, payload)
        VALUES (${state.installation.id}, ${kind}, ${id}, ${payload})
        ON CONFLICT (installation_id, kind, id) DO UPDATE SET payload = EXCLUDED.payload`);
    }
    for (const id of Object.keys(original?.[kind] ?? {})) {
      if (!Object.hasOwn(state[kind], id)) throw new LifecycleError("retention_required", "Lifecycle records cannot be removed by normal operations.");
    }
  }
}

export class DatabaseLifecycleRepository implements LifecycleRepository {
  constructor(private readonly database: ReleaseDatabase) {}

  async create(state: InstallationState): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const installation = state.installation;
      await transaction.execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload)
        VALUES (${installation.id}, ${installation.ownerId}, ${installation.scope}, ${JSON.stringify(installation)})`);
      await writeRecords(transaction, state);
    });
  }

  async read(installationId: string, database?: MigrationDb): Promise<InstallationState | null> {
    if (database) return readState(database, installationId, "share");
    return this.database.transaction((transaction) => readState(transaction, installationId, "update"));
  }

  /** Preflight before storage migration; transact repeats this under the commit lock. */
  async assertProviderReleaseDrained(installationId: string, nextReleaseId: string): Promise<void> {
    await this.database.transaction(async transaction => {
      const state = await readState(transaction, installationId, "share");
      if (!state) throw new LifecycleError("not_found", "Installation not found.");
      await assertProviderReleaseChangeDrained(transaction, state, nextReleaseId);
    });
  }

  async list(ownerId: string, scope: string): Promise<InstallationRecord[]> {
    return releaseRows<{ payload: string }>(await this.database.execute(sql`SELECT payload FROM extension_release_installations WHERE owner_id = ${ownerId} AND scope = ${scope} ORDER BY id`)).map((row) => JSON.parse(row.payload));
  }

  async transact<Result>(installationId: string, change: (state: InstallationState) => Result | Promise<Result>, actor?: LifecycleActor): Promise<Result> {
    return this.database.transaction(async (transaction) => {
      const state = await readState(transaction, installationId, "update");
      if (!state) throw new LifecycleError("not_found", "Installation not found.");
      const original = structuredClone(state);
      const result = await change(state);
      await assertProviderReleaseChangeDrained(transaction, original, state.installation.activeReleaseId);
      if (state.installation.id !== original.installation.id || state.installation.ownerId !== original.installation.ownerId || state.installation.scope !== original.installation.scope) throw new LifecycleError("immutable_identity", "Installation identity cannot change.");
      if (state.installation.activeReleaseId && state.installation.activeReleaseId !== original.installation.activeReleaseId) {
        const release = state.releases[state.installation.activeReleaseId];
        if (release) {
          const reserved = releaseRows(await transaction.execute(sql`INSERT INTO extension_release_names (name, installation_id) VALUES (${release.manifest.name}, ${installationId})
            ON CONFLICT (name) DO UPDATE SET installation_id = EXCLUDED.installation_id WHERE extension_release_names.installation_id = EXCLUDED.installation_id RETURNING installation_id`));
          if (reserved.length === 0) throw new LifecycleError("extension_name_in_use", "Another installation owns this extension name.");
        }
      }
      await writeRecords(transaction, state, original);
      if (actor) await writeLifecycleAudit(transaction, original, state, actor);
      await transaction.execute(sql`UPDATE extension_release_installations SET payload = ${JSON.stringify(state.installation)} WHERE id = ${installationId}`);
      if (state.installation.generation !== original.installation.generation || state.installation.enabled !== original.installation.enabled) {
        await transaction.execute(sql`UPDATE extension_release_deliveries SET state = 'cancelled' WHERE installation_id = ${installationId} AND state IN ('queued', 'leased') AND (generation <> ${state.installation.generation} OR ${!state.installation.enabled})`);
      }
      return structuredClone(result);
    });
  }
}

async function writeLifecycleAudit(database: MigrationDb, previous: InstallationState, current: InstallationState, actor: LifecycleActor): Promise<void> {
  const installation = current.installation;
  const before = previous.installation;
  const release = installation.activeReleaseId ? current.releases[installation.activeReleaseId] : undefined;
  const priorRelease = before.activeReleaseId ? previous.releases[before.activeReleaseId] : undefined;
  const write = async (identity: unknown, action: string, details: Record<string, unknown>) => {
    const id = `extension-lifecycle:${digestObject([installation.id, identity])}`;
    await insertTransactionalAuditEntry(database, id, actor.principalId, action, installation.id, { actor: actor.principalId, actorKind: actor.kind, ownerId: installation.ownerId, scope: installation.scope, generation: installation.generation, releaseId: release?.id ?? null, releaseDigest: release?.releaseDigest ?? null, source: "release-v4", ...details });
  };
  for (const approval of Object.values(current.approvals)) {
    const prior = previous.approvals[approval.id];
    if (prior?.status === approval.status) continue;
    await write(["approval", approval.id, approval.status], `ext:approval_${approval.status}`, { approvalId: approval.id, approvalReleaseId: approval.releaseId, approvalReleaseDigest: approval.releaseDigest, grants: approval.grants });
  }
  if (before.generation === installation.generation) return;
  const action = installation.uninstalled && !before.uninstalled ? "ext:uninstalled" : installation.enabled ? "ext:activated" : "ext:disabled";
  await write(["generation", installation.generation], action, { previousReleaseId: before.activeReleaseId, oldVersion: priorRelease?.manifest.version ?? null, version: release?.manifest.version ?? null, purgeData: false, grants: installation.grants });
}

export async function createDatabaseLifecycleRepository(): Promise<DatabaseLifecycleRepository> {
  const { getDb } = await import("../connection");
  return new DatabaseLifecycleRepository(getDb());
}

/**
 * The reserved extension name of each installation in `installationIds`, as a
 * `Map<installationId, name>`. Ids with no reserved name are simply absent.
 *
 * `extension_release_names` is written by `transact` above when an installation
 * ACTIVATES a release, so a row here is the name that installation currently
 * owns. Reading it is the batch answer to "what is this installation called" —
 * one `IN (...)` round-trip for a whole list, where `inspect`-per-installation
 * would be one full state read each.
 *
 * Empty input returns an empty map WITHOUT a round-trip. Ids are bound as
 * parameters (never interpolated), so a caller-supplied id cannot reach the SQL
 * text.
 */
export async function getReleaseNamesByInstallationIds(installationIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (installationIds.length === 0) return names;
  const unique = [...new Set(installationIds)].map((id) => sql`${id}`);
  const { getDb } = await import("../connection");
  const rows = releaseRows<{ name: string; installation_id: string }>(await getDb().execute(sql`SELECT name, installation_id FROM extension_release_names WHERE installation_id IN (${sql.join(unique, sql`, `)})`));
  for (const row of rows) names.set(row.installation_id, row.name);
  return names;
}
