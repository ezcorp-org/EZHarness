import { describe, expect, test } from "bun:test";
import type { MigrationDb } from "../db/migrations/types";
import { FACTORY_WAL_ARCHIVE_MAX_AGE_MS, factoryWalArchiveReadiness } from "./wal-backup";

/** A database double that answers the two catalog reads the report makes. */
function database(settings: Record<string, string>, archiver: Record<string, unknown>): MigrationDb {
  let call = 0;
  return { execute: async () => ({ rows: call++ === 0 ? Object.entries(settings).map(([name, setting]) => ({ name, setting })) : [archiver] }) } as unknown as MigrationDb;
}

const archiving = { wal_level: "replica", archive_mode: "on", archive_command: "cp %p /archive/%f", archive_library: "" };
const healthy = { archived_count: "42", failed_count: 0, last_archived_wal: "000000010000000000000007", age_ms: "1200", failed_after: false };

describe("continuous WAL archiving readiness", () => {
  test("archiving on, a command, a recent segment, and no failure since is ready", async () => {
    expect(await factoryWalArchiveReadiness(database(archiving, healthy))).toEqual({
      walLevel: "replica", archiveMode: "on", archiveCommandConfigured: true, archivedCount: 42, failedCount: 0,
      lastArchivedWal: "000000010000000000000007", lastArchivedAgeMs: 1200, lastFailedAfterLastArchived: false, ready: true, unmet: [],
    });
  });

  test("every unmet criterion is named", async () => {
    const off = await factoryWalArchiveReadiness(database({ wal_level: "minimal", archive_mode: "off", archive_command: "", archive_library: "" }, { archived_count: 0, failed_count: 3, last_archived_wal: null, age_ms: null, failed_after: true }));
    expect(off.ready).toBe(false);
    expect(off.unmet).toEqual(["wal-level-below-replica", "archive-mode-off", "archive-command-unset", "no-recent-archived-segment", "archiving-failing"]);
    const stale = await factoryWalArchiveReadiness(database({ ...archiving, archive_mode: "always", archive_command: "", archive_library: "basic_archive" }, { ...healthy, age_ms: FACTORY_WAL_ARCHIVE_MAX_AGE_MS + 1 }));
    expect(stale.unmet).toEqual(["no-recent-archived-segment"]);
    expect(stale.archiveCommandConfigured).toBe(true);
    expect((await factoryWalArchiveReadiness(database({}, healthy))).unmet).toEqual(["wal-level-below-replica", "archive-mode-off", "archive-command-unset"]);
  });
});
