/**
 * v1.4 — hard `*_API_KEY` install-gate coverage.
 *
 * Locks in the four-axis truth table for
 * `checkEnvKeyLeakInstallGate` at `src/extensions/clamp-permissions.ts`:
 *
 *   axis 1: leak present? — yes / no
 *   axis 2: install kind  — user / bundled
 *   axis 3: escape-hatch  — set / unset (only meaningful for bundled)
 *   axis 4: leak count    — single / multiple / mixed-with-OK
 *
 * Plus the regression-guard:
 *   - The bundled-extension WITHOUT escape-hatch flag MUST fail
 *     closed (this is the "do not silently restore the bypass" lock).
 *
 * Plus the v1.4-fix integration suite (the bottom describe block):
 *   - `installFromLocal` end-to-end with a synthetic manifest so the
 *     gate's wiring is asserted at the actual integration boundary
 *     (the unit tests above call the gate function in isolation,
 *     which let a real wiring gap ship — the unit tests passed empty
 *     env names from `grantedPermissions` while the production gate
 *     should source from `manifest.permissions.env`). Asserts the
 *     `EnvKeyLeakInstallError` propagates AND that no row was
 *     persisted to the `extensions` table.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";
import { writeConfig } from "../../__tests__/helpers/write-config";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import {
  checkEnvKeyLeakInstallGate,
  EnvKeyLeakInstallError,
} from "../clamp-permissions";
import { installFromLocal } from "../installer";
import { auditLog, extensions } from "../../db/schema";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await getTestDb().delete(auditLog);
  // The integration suite at the bottom installs into the real
  // extensions table; clear between every test so name-collision
  // checks in `installFromLocal` don't bleed across tests.
  await getTestDb().delete(extensions);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

async function blockedRows() {
  return getTestDb()
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "ext:env-key-leak-install-blocked"));
}

async function escapeHatchRows() {
  return getTestDb()
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "ext:env-key-leak-bundled-escape-hatch-used"));
}

describe("checkEnvKeyLeakInstallGate — user-installed extension (isBundled=false)", () => {
  test("single *_API_KEY env name → returns EnvKeyLeakInstallError + 1 audit row", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "user-ext-fake",
      ["FAKE_API_KEY"],
      { isBundled: false, envEscapeHatch: false },
    );
    expect(err).toBeInstanceOf(EnvKeyLeakInstallError);
    expect((err as EnvKeyLeakInstallError).leakedNames).toEqual(["FAKE_API_KEY"]);
    const blocked = await blockedRows();
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.target).toBe("user-ext-fake");
    expect((blocked[0]!.metadata as { newValue?: string }).newValue).toBe(
      "FAKE_API_KEY",
    );
    // Audit-row provenance: the install gate writes `actor: "system"`
    // because the gate is server-driven (the audit row exists even
    // when the install is admin-initiated — the actor of interest
    // here is the gate, not the operator). Pinned per coverage-
    // auditor recommendation so a future refactor that changes
    // `actor` (e.g. to the calling admin's id) has to update this
    // test in lockstep.
    expect((blocked[0]!.metadata as { actor?: string }).actor).toBe("system");
    // No escape-hatch row written — the user-install path never reaches
    // that branch.
    expect((await escapeHatchRows()).length).toBe(0);
  });

  test("multiple credential-shaped names → ONE audit row per name; error lists all", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "user-ext-multi",
      ["FOO_API_KEY", "BAR_TOKEN", "BAZ_SECRET"],
      { isBundled: false, envEscapeHatch: false },
    );
    expect(err).toBeInstanceOf(EnvKeyLeakInstallError);
    expect((err as EnvKeyLeakInstallError).leakedNames).toEqual([
      "FOO_API_KEY",
      "BAR_TOKEN",
      "BAZ_SECRET",
    ]);
    expect(err!.message).toContain("FOO_API_KEY");
    expect(err!.message).toContain("BAR_TOKEN");
    expect(err!.message).toContain("BAZ_SECRET");
    const blocked = await blockedRows();
    expect(blocked.length).toBe(3);
    const names = blocked
      .map((r) => (r.metadata as { newValue?: string }).newValue)
      .sort();
    expect(names).toEqual(["BAR_TOKEN", "BAZ_SECRET", "FOO_API_KEY"]);
  });

  test("mixed (one credential + one OK) → still rejected; only credential in error", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "user-ext-mixed",
      ["EZCORP_BASE_URL", "TAVILY_API_KEY"],
      { isBundled: false, envEscapeHatch: false },
    );
    expect(err).toBeInstanceOf(EnvKeyLeakInstallError);
    // The leakedNames only carries the credential-shaped one — the OK
    // env name is filtered out by `detectEnvKeyLeaks`.
    expect((err as EnvKeyLeakInstallError).leakedNames).toEqual([
      "TAVILY_API_KEY",
    ]);
    expect(err!.message).toContain("TAVILY_API_KEY");
    expect(err!.message).not.toContain("EZCORP_BASE_URL");
    const blocked = await blockedRows();
    expect(blocked.length).toBe(1);
  });

  test("no env permissions → null (install proceeds), no audit row", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "user-ext-clean",
      undefined,
      { isBundled: false, envEscapeHatch: false },
    );
    expect(err).toBeNull();
    expect((await blockedRows()).length).toBe(0);
    expect((await escapeHatchRows()).length).toBe(0);
  });

  test("only OK env names → null (install proceeds), no audit row", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "user-ext-only-ok",
      ["EZCORP_BASE_URL", "PATH", "HOME"],
      { isBundled: false, envEscapeHatch: false },
    );
    expect(err).toBeNull();
    expect((await blockedRows()).length).toBe(0);
  });
});

describe("checkEnvKeyLeakInstallGate — bundled extension (isBundled=true)", () => {
  test("REGRESSION GUARD: bundled WITHOUT envEscapeHatch + *_API_KEY → fails closed", async () => {
    // This is the lock. If a future refactor silently allows bundled
    // extensions to bypass the gate (e.g. by reading a manifest flag
    // that doesn't exist or by defaulting `envEscapeHatch` to true),
    // this test MUST go red. The bundled-trust-by-default model is
    // explicitly NOT extended to *_API_KEY env grants.
    const err = await checkEnvKeyLeakInstallGate(
      "bundled-no-flag",
      ["LEAKY_API_KEY"],
      { isBundled: true, envEscapeHatch: false },
    );
    expect(err).toBeInstanceOf(EnvKeyLeakInstallError);
    expect((err as EnvKeyLeakInstallError).leakedNames).toEqual(["LEAKY_API_KEY"]);
    const blocked = await blockedRows();
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.target).toBe("bundled-no-flag");
    // No escape-hatch row — the unflagged bundled path is the
    // user-path-equivalent.
    expect((await escapeHatchRows()).length).toBe(0);
  });

  test("bundled WITH envEscapeHatch + *_API_KEY → install proceeds; escape-hatch audit row written", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "bundled-flagged",
      ["TAVILY_API_KEY"],
      { isBundled: true, envEscapeHatch: true },
    );
    expect(err).toBeNull();
    // No blocked row — the gate passed.
    expect((await blockedRows()).length).toBe(0);
    // One escape-hatch row, keyed on the manifest name.
    const escapeAudits = await escapeHatchRows();
    expect(escapeAudits.length).toBe(1);
    expect(escapeAudits[0]!.target).toBe("bundled-flagged");
    expect((escapeAudits[0]!.metadata as { newValue?: string }).newValue).toBe(
      "TAVILY_API_KEY",
    );
    // Reason mentions ctx.secrets so the v1.5+ migration trail exists
    // in audit history.
    expect((escapeAudits[0]!.metadata as { reason?: string }).reason).toContain(
      "ctx.secrets",
    );
  });

  test("bundled WITH envEscapeHatch + multiple *_API_KEY → ONE escape-hatch row per name", async () => {
    const err = await checkEnvKeyLeakInstallGate(
      "bundled-multi-flagged",
      [
        "TAVILY_API_KEY",
        "BRAVE_API_KEY",
        "EXA_API_KEY",
        "SERPAPI_API_KEY",
        "JINA_API_KEY",
      ],
      { isBundled: true, envEscapeHatch: true },
    );
    expect(err).toBeNull();
    const escapeAudits = await escapeHatchRows();
    expect(escapeAudits.length).toBe(5);
    const names = escapeAudits
      .map((r) => (r.metadata as { newValue?: string }).newValue)
      .sort();
    expect(names).toEqual([
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "JINA_API_KEY",
      "SERPAPI_API_KEY",
      "TAVILY_API_KEY",
    ]);
    expect((await blockedRows()).length).toBe(0);
  });

  test("bundled WITH envEscapeHatch but NO leaks → null, no audit row", async () => {
    // The escape-hatch flag is irrelevant when there's nothing to
    // escape from. Confirms the gate doesn't write a row eagerly.
    const err = await checkEnvKeyLeakInstallGate(
      "bundled-flagged-clean",
      ["EZCORP_BASE_URL"],
      { isBundled: true, envEscapeHatch: true },
    );
    expect(err).toBeNull();
    expect((await blockedRows()).length).toBe(0);
    expect((await escapeHatchRows()).length).toBe(0);
  });
});

describe("EnvKeyLeakInstallError — error shape", () => {
  test("name + message + leakedNames frozen", () => {
    const err = new EnvKeyLeakInstallError(["FOO_API_KEY"]);
    expect(err.name).toBe("EnvKeyLeakInstallError");
    expect(err.message).toContain("FOO_API_KEY");
    expect(err.message).toContain("ctx.secrets");
    expect(err.leakedNames).toEqual(["FOO_API_KEY"]);
    expect(Object.isFrozen(err.leakedNames)).toBe(true);
    // Mutating the frozen array silently fails in non-strict mode but
    // throws in strict mode (`bun test` enforces strict mode at the
    // module level for ES modules).
    expect(() => {
      (err.leakedNames as unknown as string[]).push("X");
    }).toThrow();
  });
});

// ── Integration: installFromLocal end-to-end ──────────────────────
//
// REGRESSION GUARD for the v1.4 install-gate wiring gap. The unit
// tests above pass `envNames` to `checkEnvKeyLeakInstallGate`
// directly, which let the production gap ship: the installer was
// reading `grantedPermissions.env` (empty for user installs) instead
// of `manifest.permissions.env` (what the extension actually
// declares). These tests drive `installFromLocal` end-to-end with a
// synthetic manifest so any future refactor that re-introduces the
// "wrong source" pattern goes red HERE, not in production.

async function writeFakeExtension(
  dir: string,
  manifestOverride: Record<string, unknown>,
): Promise<void> {
  // Minimal v2 manifest — entrypoint must exist on disk so
  // computeChecksum doesn't fail. The installer doesn't execute the
  // entrypoint; it just hashes the file.
  await Bun.write(join(dir, "index.ts"), "export default {};\n");
  await writeConfig(dir, {
    schemaVersion: 2,
    name: "integration-test-ext",
    version: "0.0.1",
    description: "Integration-test fixture for the env-key-leak install gate.",
    author: { name: "test" },
    entrypoint: "index.ts",
    tools: [
      { name: "noop", description: "noop", inputSchema: { type: "object" } },
    ],
    ...manifestOverride,
  });
}

describe("installFromLocal — env-key-leak install-gate integration", () => {
  test("user install (isBundled=false) with manifest.permissions.env: ['FAKE_API_KEY'] → throws + no extensions row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envleak-user-"));
    await writeFakeExtension(dir, {
      name: "user-install-leaky",
      permissions: { env: ["FAKE_API_KEY"] },
    });

    // grantedPermissions.env is EMPTY — mirrors the actual web install
    // route which always passes `{ grantedAt: {} }`. Pre-fix this
    // means the gate read no leaks and the install proceeded.
    await expect(
      installFromLocal(dir, { grantedAt: {} } as never, false),
    ).rejects.toBeInstanceOf(EnvKeyLeakInstallError);

    // No DB row — the gate runs BEFORE createExtension.
    const rows = await getTestDb()
      .select()
      .from(extensions)
      .where(eq(extensions.name, "user-install-leaky"));
    expect(rows.length).toBe(0);

    // The audit-row trail still lands (one per leaked name).
    const blocked = await blockedRows();
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.target).toBe("user-install-leaky");
  });

  test("bundled install (isBundled=true) WITHOUT envEscapeHatch + leaky manifest → throws + no extensions row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envleak-bundled-strict-"));
    await writeFakeExtension(dir, {
      name: "bundled-no-hatch",
      permissions: { env: ["LEAKY_API_KEY"] },
    });

    await expect(
      installFromLocal(dir, { grantedAt: {} } as never, true, {
        isBundled: true,
        envEscapeHatch: false,
      }),
    ).rejects.toBeInstanceOf(EnvKeyLeakInstallError);

    const rows = await getTestDb()
      .select()
      .from(extensions)
      .where(eq(extensions.name, "bundled-no-hatch"));
    expect(rows.length).toBe(0);

    const blocked = await blockedRows();
    expect(blocked.length).toBe(1);
    // No escape-hatch row — the unflagged path is the user-equivalent.
    expect((await escapeHatchRows()).length).toBe(0);
  });

  test("bundled install (isBundled=true) WITH envEscapeHatch + leaky manifest → succeeds + extensions row + escape-hatch audit row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envleak-bundled-hatch-"));
    await writeFakeExtension(dir, {
      name: "bundled-with-hatch",
      permissions: { env: ["TAVILY_API_KEY"] },
    });

    const installed = await installFromLocal(
      dir,
      { grantedAt: {} } as never,
      true,
      { isBundled: true, envEscapeHatch: true },
    );
    expect(installed.name).toBe("bundled-with-hatch");

    const rows = await getTestDb()
      .select()
      .from(extensions)
      .where(eq(extensions.name, "bundled-with-hatch"));
    expect(rows.length).toBe(1);

    // No blocked row — the gate let it through.
    expect((await blockedRows()).length).toBe(0);
    // One escape-hatch row keyed on manifest name.
    const escapeAudits = await escapeHatchRows();
    expect(escapeAudits.length).toBe(1);
    expect(escapeAudits[0]!.target).toBe("bundled-with-hatch");
  });
});
