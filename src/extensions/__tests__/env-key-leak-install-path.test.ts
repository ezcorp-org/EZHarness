/**
 * Phase 51 — env-key-leak install-path coverage.
 *
 * After C1 wires `emitEnvKeyLeakWarnings` into the user-install /
 * activate path (in addition to the bundled-install path), driving an
 * extension install with `permissions.env: ["OPENAI_API_KEY"]` MUST
 * write an `ext:env-key-leak-warning` row to `audit_log`. This is the
 * spec-literal end-to-end assertion (the pure helper
 * `detectEnvKeyLeaks` was already covered).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { emitEnvKeyLeakWarnings } from "../clamp-permissions";
import { extensions, auditLog } from "../../db/schema";
import { eq } from "drizzle-orm";

let extId: string;

beforeAll(async () => {
  await setupTestDb();
  const [row] = await getTestDb().insert(extensions).values({
    name: "env-leak-ext", version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name: "env-leak-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  extId = row!.id;
});

beforeEach(async () => {
  await getTestDb().delete(auditLog);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("emitEnvKeyLeakWarnings — install-path integration", () => {
  test("permissions.env: ['OPENAI_API_KEY'] → ext:env-key-leak-warning audit row", async () => {
    await emitEnvKeyLeakWarnings(extId, ["OPENAI_API_KEY"]);
    const audits = await getTestDb().select().from(auditLog).where(eq(auditLog.action, "ext:env-key-leak-warning"));
    expect(audits.length).toBe(1);
    expect(audits[0]!.target).toBe(extId);
    const meta = audits[0]!.metadata as { newValue?: string; reason?: string };
    expect(meta.newValue).toBe("OPENAI_API_KEY");
    expect(meta.reason).toContain("ctx.llm");
  });

  test("permissions.env with multiple credential-shaped names → one row each", async () => {
    await emitEnvKeyLeakWarnings(extId, ["OPENAI_API_KEY", "FOO_TOKEN", "BAR_SECRET", "PATH"]);
    const audits = await getTestDb().select().from(auditLog).where(eq(auditLog.action, "ext:env-key-leak-warning"));
    // 3 credential-shaped names — `PATH` is excluded by the regex.
    expect(audits.length).toBe(3);
    const names = audits.map((a) => (a.metadata as { newValue?: string }).newValue).sort();
    expect(names).toEqual(["BAR_SECRET", "FOO_TOKEN", "OPENAI_API_KEY"]);
  });

  test("permissions.env without credential-shaped names → no audit row", async () => {
    await emitEnvKeyLeakWarnings(extId, ["PATH", "HOME", "USER"]);
    const audits = await getTestDb().select().from(auditLog).where(eq(auditLog.action, "ext:env-key-leak-warning"));
    expect(audits.length).toBe(0);
  });
});
