/**
 * The workflow-definition-version retention sub-tick on
 * `HostMaintenanceDaemon`.
 *
 * The cadence is the cheap half. The half worth the file is the C3
 * constraint: pinned versions must be EXCLUDED from the delete set, never
 * attempted-and-caught. A sweep that relied on the FK's ON DELETE
 * RESTRICT would make the database error its control flow, which is
 * backwards — and would leave the sweep's behaviour undefined the moment
 * the FK were relaxed.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";
import { createWorkflow } from "../db/queries/workflows";
import {
  DEFAULT_UNREFERENCED_VERSIONS_KEPT,
  ensureWorkflowVersion,
  listWorkflowVersions,
  sweepWorkflowDefinitionVersions,
} from "../db/queries/workflow-versions";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM audit_log`);
  await db.execute(sql`DELETE FROM extensions`);
  await db.execute(sql`DELETE FROM settings`);
  await db.execute(sql`DELETE FROM workflow_definitions`);
});

/**
 * A definition carrying `count` distinct versions.
 *
 * Versions are minted directly rather than through `updateWorkflow`: the
 * sweep reads `workflow_definition_versions` and nothing else, and the
 * cadence tests below have to seed PAST the default keep window, so
 * halving the writes per version is what keeps that affordable.
 */
async function withVersions(name: string, count: number) {
  const row = await createWorkflow({
    name,
    description: "",
    steps: [{ name: "s1", agent: "writer", input: {} }],
  } as never);
  await ensureWorkflowVersion(row, null);
  for (let i = 2; i <= count; i++) {
    await ensureWorkflowVersion(
      { ...row, steps: [{ name: `s${i}`, agent: "writer", input: {} }] } as never,
      null,
    );
  }
  return row;
}

/**
 * Seeded PAST the daemon's default keep window so a swept table and an
 * unswept one have DIFFERENT sizes.
 *
 * The pair below used to seed 3 against a keep of 50 and assert
 * `toHaveLength(3)` on both sides, which is what a swept table and an
 * unswept table both look like — so neither test could distinguish them
 * and both passed with the sweep deleted, while the comment claimed a
 * proof by contrast that did not exist.
 */
const SEEDED = DEFAULT_UNREFERENCED_VERSIONS_KEPT + 2;

describe("HostMaintenanceDaemon version-retention sub-tick", () => {
  test("ticks 1-23 do NOT sweep versions", async () => {
    const row = await withVersions("w", SEEDED);
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    for (let i = 0; i < 23; i++) await daemon.tickOnce();
    // Untouched: seeded above the keep window, so a sweep on ANY of these
    // ticks would have reaped and this count would be 50.
    expect(await listWorkflowVersions(row.id)).toHaveLength(SEEDED);
  });

  test("tick 24 runs the sweep, reaping down to the keep window", async () => {
    const row = await withVersions("w", SEEDED);
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    for (let i = 0; i < 24; i++) await daemon.tickOnce();
    // The contrast the pair exists for: 50, not the 52 the test above
    // ends on. Deleting the sub-tick fails here; moving it to every tick
    // fails above.
    expect(await listWorkflowVersions(row.id)).toHaveLength(DEFAULT_UNREFERENCED_VERSIONS_KEPT);
    expect(DEFAULT_UNREFERENCED_VERSIONS_KEPT).toBeLessThan(SEEDED);
  });

  test("a sweep failure is swallowed — housekeeping never kills the daemon", async () => {
    const daemon = new HostMaintenanceDaemon({ skipLockfile: true });
    const db = getDb();
    // Drop the table out from under the sweep so it genuinely throws.
    await db.execute(sql`DROP TABLE IF EXISTS workflow_definition_versions CASCADE`);
    for (let i = 0; i < 24; i++) {
      await expect(daemon.tickOnce()).resolves.toBeDefined();
    }
    // Restore for the suite's remaining tests.
    const { migrate } = await import("../db/migrate");
    await migrate(db);
  });
});

describe("the sweep excludes pins rather than catching the FK error", () => {
  test("a pinned version is never in the delete set", async () => {
    const row = await withVersions("w", 5);
    const versions = await listWorkflowVersions(row.id);
    const pinned = versions[1]!;

    const result = await sweepWorkflowDefinitionVersions({
      keepUnreferencedPerDefinition: 1,
      pinnedVersionIds: [pinned.id],
    });

    // v2 survives on the pin, v5 on the keep window; v1/v3/v4 are reaped.
    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([2, 5]);
    expect(result.deleted).toBe(3);
  });

  test("the pin set composes with the run-reference set", async () => {
    const row = await withVersions("w", 5);
    const versions = await listWorkflowVersions(row.id);
    const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
    await insertWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: row.name,
      workflowDefinitionId: row.id,
      input: {},
      startedAt: new Date(),
      definitionVersionId: versions[0]!.id,
    });

    await sweepWorkflowDefinitionVersions({
      keepUnreferencedPerDefinition: 1,
      pinnedVersionIds: [versions[2]!.id],
    });

    // v1 (run-referenced), v3 (caller pin), v5 (keep window).
    expect((await listWorkflowVersions(row.id)).map((v) => v.version)).toEqual([1, 3, 5]);
  });

  test("an unknown pin id is harmless", async () => {
    const row = await withVersions("w", 3);
    await sweepWorkflowDefinitionVersions({
      keepUnreferencedPerDefinition: 1,
      pinnedVersionIds: [crypto.randomUUID()],
    });
    expect(await listWorkflowVersions(row.id)).toHaveLength(1);
  });
});
