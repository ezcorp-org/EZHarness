/**
 * Cap-expiry Phase 2 — `applySweepResult` integration coverage.
 *
 * Exercises the apply step against a real PGlite instance, plus the
 * race-mitigation skip path under simulated concurrent writes, plus a
 * CLI smoke test (`bun run scripts/sweep-perm-expiry.ts --dry-run`).
 *
 * Pattern mirrors `audit-log-redaction-integration.test.ts` for db
 * mocking + real settings module wiring (so `insertAuditEntry` writes
 * land in the test DB and `parseAlwaysAllowValue` reads come from the
 * same place).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { spawn } from "bun";
import { eq } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  closeTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

// Wire a real settings module backed by the test DB — needed by the
// always-allow seed paths.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: { key: string; value: unknown }) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting() {
      return false;
    },
    async isListingInstalled() {
      return false;
    },
  };
});

mockDbConnection();

import { sql } from "drizzle-orm";
import { applySweepResult, runSweep } from "../extensions/perm-expiry-sweep";
import { extensions, settings } from "../db/schema";
import { listAuditLog } from "../db/queries/audit-log";
import { getDb } from "../db/connection";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Wipe the tables we touch between tests so each case starts clean.
  // Use raw SQL to avoid worrying about FK ordering.
  const db = getDb();
  await db.execute(sql`DELETE FROM audit_log`);
  await db.execute(sql`DELETE FROM extensions`);
  await db.execute(sql`DELETE FROM settings`);
});

// Insert a synthetic extension row. Mirror the connection-layer
// identity-jsonb mapper trick so the value lands as proper jsonb.
async function seedExtension(opts: {
  id: string;
  name: string;
  enabled: boolean;
  perms: import("../extensions/types").ExtensionPermissions;
}) {
  const db = getDb();
  await db.insert(extensions).values({
    id: opts.id,
    name: opts.name,
    version: "1.0.0",
    description: "test fixture",
    manifest: sql`${JSON.stringify({
      schemaVersion: 2,
      name: opts.name,
      version: "1.0.0",
      description: "",
      author: { name: "test" },
      kind: "subprocess",
      entrypoint: { command: ["true"] },
      tools: [],
      permissions: {},
    })}::jsonb`,
    source: "test:fixture",
    installPath: null,
    enabled: opts.enabled,
    grantedPermissions: sql`${JSON.stringify(opts.perms)}::jsonb`,
    checksumVerified: false,
    isBundled: false,
    consecutiveFailures: 0,
  });
}

async function seedSetting(key: string, value: unknown) {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key, value: sql`${JSON.stringify(value)}::jsonb` });
}

async function readExtension(id: string) {
  const db = getDb();
  const rows = await db.select().from(extensions).where(eq(extensions.id, id));
  return rows[0];
}

async function readSetting(key: string) {
  const db = getDb();
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return rows[0]?.value;
}

// ── runSweep + applySweepResult — happy path ────────────────────────

describe("applySweepResult — extension-grant rewrite", () => {
  test("rewrites granted_permissions, drops aged grant, writes audit", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-1",
      name: "fix-1",
      enabled: true,
      perms: {
        network: ["api.example.com"],
        filesystem: ["/tmp/foo"],
        grantedAt: {
          network: NOW - 91 * DAY_MS,
          filesystem: NOW - 5 * DAY_MS, // fresh — keep
        },
      },
    });

    const db = getDb();
    const result = await runSweep({ db, now: NOW });
    expect(result.revocations).toHaveLength(1);
    expect(result.revocations[0]?.capability).toBe("network");

    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.applied).toBe(1);
    expect(outcome.skippedConcurrent).toBe(0);
    expect(outcome.errors).toEqual([]);
    expect(outcome.audits).toBeGreaterThanOrEqual(1);

    // DB was rewritten — network gone, filesystem retained.
    const ext = await readExtension("ext-1");
    expect(ext).toBeDefined();
    const perms = ext?.grantedPermissions;
    expect(perms?.network).toBeUndefined();
    expect(perms?.filesystem).toEqual(["/tmp/foo"]);
    expect(perms?.grantedAt.network).toBeUndefined();
    expect(perms?.grantedAt.filesystem).toBe(NOW - 5 * DAY_MS);

    // Audit row landed with the expected metadata shape.
    const audits = await listAuditLog({
      action: "ext:permission-grant-expired",
    });
    const matching = audits.filter((row) => row.target === "ext-1");
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const meta = matching[0]?.metadata as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta?.capability).toBe("network");
    expect(meta?.scope).toBe("extensions-row");
    expect(meta?.ttlMs).toBe(90 * DAY_MS);
    expect(meta?.ageMs).toBe(91 * DAY_MS);
  });

  test("multi-key revocation on the same extension applies in one UPDATE", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-multi",
      name: "fix-multi",
      enabled: true,
      perms: {
        network: ["api.x"],
        shell: true,
        env: ["FOO"],
        grantedAt: {
          network: NOW - 91 * DAY_MS, // 90d TTL
          shell: NOW - 31 * DAY_MS, // 30d TTL
          env: NOW - 5 * DAY_MS, // fresh
        },
      },
    });
    const db = getDb();
    const result = await runSweep({ db, now: NOW });
    expect(result.revocations).toHaveLength(2);
    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.applied).toBe(2);
    expect(outcome.errors).toEqual([]);

    const ext = await readExtension("ext-multi");
    expect(ext?.grantedPermissions?.network).toBeUndefined();
    expect(ext?.grantedPermissions?.shell).toBeUndefined();
    expect(ext?.grantedPermissions?.env).toEqual(["FOO"]);
  });
});

// ── applySweepResult — always-allow rewrite ─────────────────────────

describe("applySweepResult — always-allow rewrite", () => {
  test("forever-scope row past TTL is rewritten to {allowed:false}", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-aa",
      name: "aa-ext",
      enabled: true,
      perms: { grantedAt: {} },
    });
    const key = "ext:ext-aa:user-1:forever:*:always_allow:shell";
    await seedSetting(key, { allowed: true, grantedAt: NOW - 91 * DAY_MS });

    const db = getDb();
    const result = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(result.revocations).toHaveLength(1);
    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.applied).toBe(1);
    expect(outcome.skippedConcurrent).toBe(0);

    const stored = (await readSetting(key)) as
      | { allowed: boolean; grantedAt: number }
      | undefined;
    expect(stored?.allowed).toBe(false);
    expect(stored?.grantedAt).toBe(NOW);

    const audits = await listAuditLog({
      action: "ext:permission-grant-expired",
    });
    const meta = audits.find((r) => r.target === "ext-aa")?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(meta?.scope).toBe("forever");
    expect(meta?.capability).toBe("shell");
  });

  test("legacy `true` always-allow value is left untouched (never-expires)", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-legacy",
      name: "legacy",
      enabled: true,
      perms: { grantedAt: {} },
    });
    const key = "ext:ext-legacy:user-1:forever:*:always_allow:shell";
    await seedSetting(key, true);

    const db = getDb();
    const result = await runSweep({ db, now: NOW });
    expect(result.revocations).toEqual([]);
    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.applied).toBe(0);

    expect(await readSetting(key)).toBe(true);
  });

  test("session-scope row is never swept (in-memory only)", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-sess",
      name: "sess",
      enabled: true,
      perms: { grantedAt: {} },
    });
    const key = "ext:ext-sess:user-1:session:*:always_allow:shell";
    await seedSetting(key, { allowed: true, grantedAt: NOW - 1000 * DAY_MS });

    const db = getDb();
    const result = await runSweep({ db, now: NOW });
    expect(result.revocations).toEqual([]);
  });
});

// ── applySweepResult — race mitigation (CHECK clause) ───────────────

describe("applySweepResult — race mitigation", () => {
  test("concurrent rewrite of granted_permissions between read+write → row skipped, no error", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-race",
      name: "race",
      enabled: true,
      perms: {
        network: ["api.x"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });
    const db = getDb();

    // Compute the plan with the original grant.
    const result = await runSweep({ db, now: NOW });
    expect(result.revocations).toHaveLength(1);

    // Simulate a concurrent user-approve: the row's
    // granted_permissions is rewritten to a fresh shape BEFORE
    // applySweepResult runs.
    const fresh = {
      network: ["api.x"],
      grantedAt: { network: NOW - 1 * DAY_MS },
    };
    await db
      .update(extensions)
      .set({ grantedPermissions: sql`${JSON.stringify(fresh)}::jsonb` })
      .where(eq(extensions.id, "ext-race"));

    // Apply now should detect the mismatch and skip — not error.
    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.errors).toEqual([]);
    expect(outcome.applied).toBe(0);
    expect(outcome.skippedConcurrent).toBe(1);

    // The freshly-approved value is preserved, not clobbered.
    const ext = await readExtension("ext-race");
    expect(ext?.grantedPermissions?.network).toEqual(["api.x"]);
    expect(ext?.grantedPermissions?.grantedAt.network).toBe(NOW - 1 * DAY_MS);
  });

  test("concurrent rewrite of always-allow row between read+write → skipped, no error", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-aa-race",
      name: "aa-race",
      enabled: true,
      perms: { grantedAt: {} },
    });
    const key = "ext:ext-aa-race:user-1:forever:*:always_allow:shell";
    await seedSetting(key, { allowed: true, grantedAt: NOW - 91 * DAY_MS });
    const db = getDb();

    const result = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(result.revocations).toHaveLength(1);

    // Concurrent re-approve: user just clicked Approve.
    const fresh = { allowed: true, grantedAt: NOW - 1 * DAY_MS };
    await db
      .update(settings)
      .set({ value: sql`${JSON.stringify(fresh)}::jsonb` })
      .where(eq(settings.key, key));

    const outcome = await applySweepResult(db, result, NOW);
    expect(outcome.errors).toEqual([]);
    expect(outcome.applied).toBe(0);
    expect(outcome.skippedConcurrent).toBe(1);

    // The fresh approve survived.
    const stored = (await readSetting(key)) as { allowed: boolean; grantedAt: number };
    expect(stored.allowed).toBe(true);
    expect(stored.grantedAt).toBe(NOW - 1 * DAY_MS);
  });
});

// ── runSweep + applySweepResult — idempotence ────────────────────────

describe("idempotence", () => {
  test("running sweep+apply twice on the same DB yields zero revocations on the second pass", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-idem",
      name: "idem",
      enabled: true,
      perms: {
        network: ["api.x"],
        grantedAt: { network: NOW - 91 * DAY_MS },
      },
    });
    const db = getDb();

    const r1 = await runSweep({ db, now: NOW });
    expect(r1.revocations).toHaveLength(1);
    await applySweepResult(db, r1, NOW);

    const r2 = await runSweep({ db, now: NOW });
    expect(r2.revocations).toEqual([]);
    const outcome2 = await applySweepResult(db, r2, NOW);
    expect(outcome2.applied).toBe(0);
    expect(outcome2.audits).toBe(0);
  });

  test("audit_log gains exactly one row per real revocation across two runs", async () => {
    const NOW = Date.now();
    await seedExtension({
      id: "ext-audit",
      name: "audit",
      enabled: true,
      perms: {
        network: ["api.x"],
        shell: true,
        grantedAt: {
          network: NOW - 91 * DAY_MS,
          shell: NOW - 31 * DAY_MS,
        },
      },
    });
    const db = getDb();

    const r1 = await runSweep({ db, now: NOW });
    await applySweepResult(db, r1, NOW);
    const r2 = await runSweep({ db, now: NOW });
    await applySweepResult(db, r2, NOW);

    const rows = await listAuditLog({
      action: "ext:permission-grant-expired",
    });
    const ours = rows.filter((r) => r.target === "ext-audit");
    expect(ours).toHaveLength(2); // network + shell, written exactly once
  });
});

// ── CLI smoke ────────────────────────────────────────────────────────

describe("CLI smoke — scripts/sweep-perm-expiry.ts", () => {
  test("--help prints usage and exits 0", async () => {
    const proc = spawn({
      cmd: ["bun", "run", "scripts/sweep-perm-expiry.ts", "--help"],
      cwd: import.meta.dir.replace(/\/src\/__tests__$/, ""),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--dry-run");
  });

  test("unknown flag exits 2 with usage text", async () => {
    const proc = spawn({
      cmd: ["bun", "run", "scripts/sweep-perm-expiry.ts", "--bogus"],
      cwd: import.meta.dir.replace(/\/src\/__tests__$/, ""),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag");
  });

  test("--dry-run against an empty PGlite DB exits 0 with planned-revocation summary", async () => {
    // Spawn the CLI against a one-shot file-backed PGlite (the
    // `:memory:` code path in `connection.ts` has a pre-existing
    // PGlite-extension loading bug unrelated to this phase — the
    // file-backed path is the documented production codepath
    // anyway). Tmp dir is left behind on /tmp; OS scratch reclaims it.
    const dbDir = `/tmp/ez-corp-cap-expiry-cli-smoke-${process.pid}-${Date.now()}`;
    const proc = spawn({
      cmd: ["bun", "run", "scripts/sweep-perm-expiry.ts", "--dry-run"],
      cwd: import.meta.dir.replace(/\/src\/__tests__$/, ""),
      env: {
        ...process.env,
        EZCORP_DB_PATH: dbDir,
        // Detach DATABASE_URL so the script boots the same PGlite path
        // every test has access to.
        DATABASE_URL: "",
        EZCORP_NO_EXIT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      // Surface stderr in the failure message so a regression is
      // diagnosable from the test log alone (logger writes JSON to
      // stderr — search for "level":"error").
      throw new Error(
        `CLI exited ${code}; stderr:\n${stderr}\nstdout:\n${stdout}`,
      );
    }
    // Summary is JSON-parseable. The connection layer's logger writes
    // info-level boot lines to stdout ahead of our summary; pull just
    // the trailing summary block (the only multi-line `{...}` at the
    // very end of stdout). No "newline-delimited JSON" formatting in
    // the boot lines (each is a single-line JSON), so the summary's
    // `{\n  "dryRun":` start sequence is unambiguous.
    const summaryStart = stdout.lastIndexOf("{\n");
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    const summary = JSON.parse(stdout.slice(summaryStart));
    expect(summary.dryRun).toBe(true);
    expect(summary.plannedRevocations).toBe(0);
    expect(summary.plannedAudits).toBe(0);
    expect(summary.plannedEvents).toBe(0);
  });
});
