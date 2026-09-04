import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertJson, canonicalJson, type InstallationRecord, type OperationRecord, type ReleaseRecord } from "@ezcorp/extension-contract";
import { releaseRows, type ReleaseDatabase } from "../../db/queries/extension-releases";
import type { MigrationDb } from "../../db/migrations/types";
import { LifecycleError } from "./types";

interface StorageRow { id: string; scope: string; scope_id: string | null; key: string; value: unknown; encrypted: boolean; size_bytes: number; expires_at: string | null; created_at: string; updated_at: string }
interface MigrationRow { id: string; installation_id: string; target_release_id: string; target_version: string; previous_version: string; fence: number; state: "preparing" | "prepared" | "committed" | "restored"; snapshot: string }

export interface StorageMigrationInput {
  release: ReleaseRecord;
  method: string;
  principalId: string;
  scope: string;
  fromVersion: string;
  toVersion: string;
  values: Record<string, unknown>;
}

async function restoreRows(transaction: MigrationDb, installationId: string, rows: StorageRow[], migrationId: string): Promise<void> {
  await transaction.execute(sql`SELECT set_config('ezcorp.extension_migration', ${migrationId}, true)`);
  await transaction.execute(sql`DELETE FROM extension_storage WHERE extension_id = ${installationId}`);
  for (const row of rows) {
    await transaction.execute(sql`INSERT INTO extension_storage (id, extension_id, scope, scope_id, key, value, encrypted, size_bytes, expires_at, created_at, updated_at)
      VALUES (${row.id}, ${installationId}, ${row.scope}, ${row.scope_id}, ${row.key}, (${JSON.stringify(row.value)}::text)::jsonb, ${row.encrypted}, ${row.size_bytes}, ${row.expires_at}, ${row.created_at}, ${row.updated_at})`);
  }
}

async function pointerCommitted(database: MigrationDb, installation: InstallationRecord, migration: MigrationRow): Promise<boolean> {
  const record = releaseRows<{ payload: string }>(await database.execute(sql`SELECT payload FROM extension_release_records WHERE installation_id = ${installation.id} AND kind = 'operations' AND id = ${migration.id}`))[0];
  const operation: OperationRecord | undefined = record ? JSON.parse(record.payload) : undefined;
  return installation.activeReleaseId === migration.target_release_id && Boolean(operation && ["reconciling", "active"].includes(operation.state));
}

export class ExtensionDataMigrations {
  constructor(private readonly database: ReleaseDatabase, private readonly transform: (input: StorageMigrationInput) => Promise<unknown>) {}

  async isPaused(installationId: string): Promise<boolean> {
    return releaseRows(await this.database.execute(sql`SELECT 1 FROM extension_release_data_state WHERE installation_id = ${installationId} AND migration_id IS NOT NULL`)).length > 0;
  }

  async prepare(installation: InstallationRecord, previous: ReleaseRecord | null, release: ReleaseRecord, operation: OperationRecord): Promise<void> {
    const fence = operation.lease?.fence;
    if (!fence) throw new LifecycleError("migration_lease_required", "Migration requires a fenced activation lease.");
    const target = release.manifest.dataSchema;
    if (!target && !previous?.manifest.dataSchema) return;
    const targetVersion = target?.version ?? "unversioned";
    const migration = await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`LOCK TABLE extension_storage IN SHARE ROW EXCLUSIVE MODE`);
      await transaction.execute(sql`INSERT INTO extension_release_data_state (installation_id, version) VALUES (${installation.id}, ${previous?.manifest.dataSchema?.version ?? "unversioned"}) ON CONFLICT (installation_id) DO NOTHING`);
      const states = releaseRows<{ version: string; migration_id: string | null }>(await transaction.execute(sql`SELECT version, migration_id FROM extension_release_data_state WHERE installation_id = ${installation.id} FOR UPDATE`));
      const state = states[0]!;
      const existing = releaseRows<MigrationRow>(await transaction.execute(sql`SELECT * FROM extension_release_data_migrations WHERE id = ${operation.id}`))[0];
      if (existing) {
        if (existing.state === "restored") throw new LifecycleError("migration_restored", "This migration was restored. Request a new activation.");
        if (existing.fence > fence) throw new LifecycleError("migration_lease_lost", "A newer activation owns this migration.");
        await transaction.execute(sql`UPDATE extension_release_data_migrations SET fence = ${fence} WHERE id = ${operation.id}`);
        existing.fence = fence;
        return existing;
      }
      if (state.migration_id) throw new LifecycleError("migration_busy", "Another data migration holds the storage gate.");
      const readable = state.version === targetVersion || Boolean(target?.readableVersions.includes(state.version));
      if (!readable && operation.rollback) throw new LifecycleError("data_restore_required", "This prior release cannot read current data. An explicit data restore decision is required.");
      if (!readable && !target?.migrateMethod) throw new LifecycleError("data_migration_required", "This release requires a declared isolated storage migration.");
      await transaction.execute(sql`UPDATE extension_release_data_state SET migration_id = ${operation.id} WHERE installation_id = ${installation.id}`);
      const snapshot = releaseRows<StorageRow>(await transaction.execute(sql`SELECT id, scope, scope_id, key, value, encrypted, size_bytes, expires_at, created_at, updated_at FROM extension_storage WHERE extension_id = ${installation.id} ORDER BY id`));
      if (!readable && snapshot.some((row) => row.encrypted)) throw new LifecycleError("encrypted_migration_unsupported", "Encrypted values require a separate approved migration. No storage was changed.");
      const record: MigrationRow = { id: operation.id, installation_id: installation.id, target_release_id: release.id, target_version: targetVersion, previous_version: state.version, fence, state: readable ? "prepared" : "preparing", snapshot: JSON.stringify(snapshot) };
      await transaction.execute(sql`INSERT INTO extension_release_data_migrations (id, installation_id, target_release_id, target_version, previous_version, fence, state, snapshot) VALUES (${record.id}, ${record.installation_id}, ${record.target_release_id}, ${record.target_version}, ${record.previous_version}, ${record.fence}, ${record.state}, ${record.snapshot})`);
      return record;
    });
    if (migration.state !== "preparing") return;
    try {
      const rows: StorageRow[] = JSON.parse(migration.snapshot);
      const groups = new Map<string, StorageRow[]>();
      for (const row of rows) {
        const key = canonicalJson([row.scope, row.scope_id]);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      const transformed: StorageRow[] = [];
      for (const group of groups.values()) {
        const first = group[0]!;
        const values = Object.fromEntries(group.map((row) => [row.key, row.value]));
        assertJson(values, 512 * 1024);
        const result = await this.transform({ release, method: target!.migrateMethod!, principalId: first.scope === "user" ? first.scope_id! : installation.ownerId, scope: canonicalJson([first.scope, first.scope_id]), fromVersion: migration.previous_version, toVersion: targetVersion, values });
        assertJson(result, 512 * 1024);
        if (!result || Array.isArray(result) || typeof result !== "object" || Object.keys(result).length !== 1 || !("values" in result) || !result.values || Array.isArray(result.values) || typeof result.values !== "object") throw new LifecycleError("invalid_migration_output", "Migration must return an object containing only a values map.");
        for (const [key, value] of Object.entries(result.values)) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-/:]{0,255}$/.test(key) || key.startsWith("ezcorp/")) throw new LifecycleError("invalid_migration_key", "Migration returned an invalid storage key.");
          const existing = group.find((row) => row.key === key);
          const now = new Date().toISOString();
          transformed.push({ id: existing?.id ?? randomUUID(), scope: first.scope, scope_id: first.scope_id, key, value, encrypted: false, size_bytes: Buffer.byteLength(JSON.stringify(value)), expires_at: existing?.expires_at ?? null, created_at: existing?.created_at ?? now, updated_at: now });
        }
      }
      await this.database.transaction(async (transaction) => {
        await transaction.execute(sql`LOCK TABLE extension_storage IN SHARE ROW EXCLUSIVE MODE`);
        const state = releaseRows<{ migration_id: string | null }>(await transaction.execute(sql`SELECT migration_id FROM extension_release_data_state WHERE installation_id = ${installation.id} FOR UPDATE`))[0];
        const current = releaseRows<{ fence: number }>(await transaction.execute(sql`SELECT fence FROM extension_release_data_migrations WHERE id = ${operation.id}`))[0];
        if (state?.migration_id !== operation.id || current?.fence !== fence) throw new LifecycleError("migration_lease_lost", "This migration no longer holds the storage gate.");
        await restoreRows(transaction, installation.id, transformed, operation.id);
        await transaction.execute(sql`UPDATE extension_release_data_migrations SET state = 'prepared' WHERE id = ${operation.id}`);
      });
    } catch (error) { await this.abort(installation.id, operation.id, fence); throw error; }
  }

  async abort(installationId: string, operationId: string, fence?: number): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`LOCK TABLE extension_storage IN SHARE ROW EXCLUSIVE MODE`);
      const installation = releaseRows<{ payload: string }>(await transaction.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId} FOR UPDATE`))[0];
      const state = releaseRows<{ migration_id: string | null }>(await transaction.execute(sql`SELECT migration_id FROM extension_release_data_state WHERE installation_id = ${installationId} FOR UPDATE`))[0];
      if (state?.migration_id !== operationId) return;
      const migration = releaseRows<MigrationRow>(await transaction.execute(sql`SELECT * FROM extension_release_data_migrations WHERE id = ${operationId}`))[0]!;
      if (fence !== undefined && migration.fence !== fence) return;
      const current: InstallationRecord = JSON.parse(installation!.payload);
      if (await pointerCommitted(transaction, current, migration)) return;
      await restoreRows(transaction, installationId, JSON.parse(migration.snapshot), operationId);
      await transaction.execute(sql`UPDATE extension_release_data_state SET migration_id = NULL, version = ${migration.previous_version} WHERE installation_id = ${installationId}`);
      await transaction.execute(sql`UPDATE extension_release_data_migrations SET state = 'restored' WHERE id = ${operationId}`);
    });
  }

  async finalize(installationId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const installation = releaseRows<{ payload: string }>(await transaction.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId} FOR UPDATE`))[0];
      const state = releaseRows<{ migration_id: string | null }>(await transaction.execute(sql`SELECT migration_id FROM extension_release_data_state WHERE installation_id = ${installationId} FOR UPDATE`))[0];
      if (!state?.migration_id) return;
      const migration = releaseRows<MigrationRow>(await transaction.execute(sql`SELECT * FROM extension_release_data_migrations WHERE id = ${state.migration_id}`))[0]!;
      const current: InstallationRecord = JSON.parse(installation!.payload);
      if (!(await pointerCommitted(transaction, current, migration)) || migration.state !== "prepared") throw new LifecycleError("migration_not_committed", "Migration cannot resume writes before its prepared release is active.");
      await transaction.execute(sql`UPDATE extension_release_data_state SET migration_id = NULL, version = ${migration.target_version} WHERE installation_id = ${installationId}`);
      await transaction.execute(sql`UPDATE extension_release_data_migrations SET state = 'committed' WHERE id = ${migration.id}`);
    });
  }

  async recover(installationId: string): Promise<void> {
    const state = releaseRows<{ migration_id: string | null }>(await this.database.execute(sql`SELECT migration_id FROM extension_release_data_state WHERE installation_id = ${installationId}`))[0];
    if (!state?.migration_id) return;
    const installation = releaseRows<{ payload: string }>(await this.database.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${installationId}`))[0];
    const migration = releaseRows<MigrationRow>(await this.database.execute(sql`SELECT * FROM extension_release_data_migrations WHERE id = ${state.migration_id}`))[0]!;
    if (await pointerCommitted(this.database, JSON.parse(installation!.payload), migration)) { await this.finalize(installationId); return; }
    const record = releaseRows<{ payload: string }>(await this.database.execute(sql`SELECT payload FROM extension_release_records WHERE installation_id = ${installationId} AND kind = 'operations' AND id = ${migration.id}`))[0];
    const operation: OperationRecord | undefined = record ? JSON.parse(record.payload) : undefined;
    if (!operation || ["cancelled", "failed"].includes(operation.state)) await this.abort(installationId, migration.id, migration.fence);
  }
}
