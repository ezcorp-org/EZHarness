import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { FactoryEncryptionError, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";

/** PostgreSQL key-wrap ledger. It stores encrypted data-key wraps and never master material. */
export class DatabaseInstallationKeyWrapStore implements InstallationKeyWrapStore {
  private readonly database: TransactionalDb;
  constructor(database: TransactionalDb) { this.database = database; }

  async load(installationId: string): Promise<readonly InstallationKeyWrap[]> {
    if (!installationId) throw new FactoryEncryptionError("factory_key_invalid");
    const rows = releaseRows<{ installation_id: string; wrap_version: number | string; master_key_id: string; wrapped_data_key: Uint8Array }>(await this.database.execute(sql`SELECT installation_id, wrap_version, master_key_id, wrapped_data_key FROM factory_installation_key_wraps WHERE installation_id=${installationId} ORDER BY wrap_version DESC`));
    return rows.map(row => ({ installationId: row.installation_id, wrapVersion: Number(row.wrap_version), masterKeyId: row.master_key_id, wrappedDataKey: new Uint8Array(row.wrapped_data_key) }));
  }

  async save(value: InstallationKeyWrap): Promise<void> {
    if (!value.installationId || !value.masterKeyId || value.wrappedDataKey.byteLength < 80 || !Number.isSafeInteger(value.wrapVersion) || value.wrapVersion < 1) throw new FactoryEncryptionError("factory_key_invalid");
    await this.database.execute(sql`INSERT INTO factory_installation_key_wraps(installation_id, wrap_version, master_key_id, wrapped_data_key) VALUES (${value.installationId}, ${value.wrapVersion}, ${value.masterKeyId}, ${Buffer.from(value.wrappedDataKey)}) ON CONFLICT (installation_id, wrap_version) DO NOTHING`);
  }
}
