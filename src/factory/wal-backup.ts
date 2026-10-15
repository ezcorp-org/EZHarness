import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";

/**
 * C06 continuous WAL backup, as the product database reports it (W15).
 *
 * The barrier's recovery position is only useful if the WAL that reaches it is
 * being archived continuously. This reads the server's own settings and its
 * archiver statistics and names every unmet criterion: archiving on, a command
 * configured, nothing failing since the last success, and a segment archived
 * recently enough that the newest checkpoint can be replayed to. It changes
 * nothing; the operator configures archiving (C12's checklist).
 */

export const FACTORY_WAL_ARCHIVE_MAX_AGE_MS = 15 * 60_000;

export interface FactoryWalArchiveReport {
  readonly walLevel: string;
  readonly archiveMode: string;
  readonly archiveCommandConfigured: boolean;
  readonly archivedCount: number;
  readonly failedCount: number;
  readonly lastArchivedWal: string | null;
  readonly lastArchivedAgeMs: number | null;
  readonly lastFailedAfterLastArchived: boolean;
  readonly ready: boolean;
  readonly unmet: readonly string[];
}

export async function factoryWalArchiveReadiness(database: MigrationDb, maxAgeMs = FACTORY_WAL_ARCHIVE_MAX_AGE_MS): Promise<FactoryWalArchiveReport> {
  const settings = rows<{ name: string; setting: string }>(await database.execute(sql`SELECT name, setting FROM pg_settings WHERE name IN ('wal_level', 'archive_mode', 'archive_command', 'archive_library')`));
  const setting = (name: string) => settings.find(row => row.name === name)?.setting ?? "";
  const archiver = rows<{ archived_count: string | number; failed_count: string | number; last_archived_wal: string | null; age_ms: string | number | null; failed_after: boolean | null }>(await database.execute(sql`SELECT archived_count, failed_count, last_archived_wal,
      floor(extract(epoch FROM clock_timestamp() - last_archived_time) * 1000) AS age_ms,
      (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) AS failed_after
    FROM pg_stat_archiver`))[0]!;
  const archiveMode = setting("archive_mode");
  const archiveCommandConfigured = setting("archive_command") !== "" || setting("archive_library") !== "";
  const lastArchivedAgeMs = archiver.age_ms === null ? null : Number(archiver.age_ms);
  const lastFailedAfterLastArchived = archiver.failed_after === true;
  const unmet = [
    ...(["replica", "logical"].includes(setting("wal_level")) ? [] : ["wal-level-below-replica"]),
    ...(archiveMode === "on" || archiveMode === "always" ? [] : ["archive-mode-off"]),
    ...(archiveCommandConfigured ? [] : ["archive-command-unset"]),
    ...(lastArchivedAgeMs !== null && lastArchivedAgeMs <= maxAgeMs ? [] : ["no-recent-archived-segment"]),
    ...(lastFailedAfterLastArchived ? ["archiving-failing"] : []),
  ];
  return Object.freeze({
    walLevel: setting("wal_level"), archiveMode, archiveCommandConfigured,
    archivedCount: Number(archiver.archived_count), failedCount: Number(archiver.failed_count),
    lastArchivedWal: archiver.last_archived_wal, lastArchivedAgeMs, lastFailedAfterLastArchived,
    ready: unmet.length === 0, unmet: Object.freeze(unmet),
  });
}
