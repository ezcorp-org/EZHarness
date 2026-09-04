import { sql } from "drizzle-orm";
import type { MigrationDb } from "../migrations/types";
import { LifecycleError, type InstallationRecord, type InstallationState, type LifecycleRepository } from "../../extensions/v4/types";

export interface ReleaseDatabase extends MigrationDb {
  transaction<Result>(work: (transaction: MigrationDb) => Promise<Result>): Promise<Result>;
}

export function releaseRows<Result>(result: unknown): Result[] {
  if (Array.isArray(result)) return result as Result[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows as Result[];
  throw new LifecycleError("database_result", "The database returned an unsupported result.");
}

const recordKinds = ["workspaces", "revisions", "operations", "releases", "approvals"] as const;

async function readState(db: MigrationDb, installationId: string, lock: boolean): Promise<InstallationState | null> {
  const installationRows = releaseRows<{ payload: string }>(await db.execute(lock
    ? sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId} FOR UPDATE`
    : sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId}`));
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

  async read(installationId: string): Promise<InstallationState | null> {
    return this.database.transaction((transaction) => readState(transaction, installationId, true));
  }

  async list(ownerId: string, scope: string): Promise<InstallationRecord[]> {
    return releaseRows<{ payload: string }>(await this.database.execute(sql`SELECT payload FROM extension_release_installations WHERE owner_id = ${ownerId} AND scope = ${scope} ORDER BY id`)).map((row) => JSON.parse(row.payload));
  }

  async transact<Result>(installationId: string, change: (state: InstallationState) => Result | Promise<Result>): Promise<Result> {
    return this.database.transaction(async (transaction) => {
      const state = await readState(transaction, installationId, true);
      if (!state) throw new LifecycleError("not_found", "Installation not found.");
      const original = structuredClone(state);
      const result = await change(state);
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
      await transaction.execute(sql`UPDATE extension_release_installations SET payload = ${JSON.stringify(state.installation)} WHERE id = ${installationId}`);
      if (state.installation.generation !== original.installation.generation || state.installation.enabled !== original.installation.enabled) {
        await transaction.execute(sql`UPDATE extension_release_deliveries SET state = 'cancelled' WHERE installation_id = ${installationId} AND state IN ('queued', 'leased') AND (generation <> ${state.installation.generation} OR ${!state.installation.enabled})`);
      }
      return structuredClone(result);
    });
  }
}

export async function createDatabaseLifecycleRepository(): Promise<DatabaseLifecycleRepository> {
  const { getDb } = await import("../connection");
  return new DatabaseLifecycleRepository(getDb());
}
