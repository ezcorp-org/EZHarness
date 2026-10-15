import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { factoryWalArchiveReadiness } from "../../src/factory/wal-backup";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * The WAL readiness report against a real server. It must describe the server
 * exactly as its own catalog does; whether that server archives is the
 * deployment's fact, and the report is recorded as evidence either way.
 */
let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => { fixture = await setupFactoryPostgres(); });
afterAll(async () => { await fixture?.close(); });

test("the report matches the server's own archiving settings", async () => {
  const report = await factoryWalArchiveReadiness(fixture.db);
  const archiveMode = rows<{ archive_mode: string }>(await fixture.db.execute(sql`SHOW archive_mode`))[0]!.archive_mode;
  expect(report.archiveMode).toBe(archiveMode);
  expect(report.ready).toBe(report.unmet.length === 0);
  expect(report.unmet.includes("archive-mode-off")).toBe(archiveMode === "off");
  if (process.env.W15_EVIDENCE_DIR) {
    await mkdir(process.env.W15_EVIDENCE_DIR, { recursive: true });
    await writeFile(`${process.env.W15_EVIDENCE_DIR}/wal-readiness-${process.env.W15_DATABASE_LABEL ?? "database"}.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), database: process.env.W15_DATABASE_LABEL ?? "database", report }, null, 2)}\n`);
  }
});
