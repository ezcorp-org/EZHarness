/**
 * Host installer end-to-end coverage for the `substack-pilot` extension.
 *
 * Coverage gap #2. install-gate.test.ts (in the extension's own tests dir)
 * already exercises `checkEnvKeyLeakInstallGate` against the manifest in
 * isolation. This file proves the bigger contract: that `installFromLocal`
 * — the host's real install entrypoint — accepts substack-pilot's manifest
 * end-to-end (env-leak gate, settings registration via the persisted
 * manifest payload, checksum, DB write) AND that re-adding a
 * credential-shaped env grant trips `EnvKeyLeakInstallError` through the
 * real installer (not just the gate function called directly).
 *
 * Mocks: same shape as src/__tests__/installer.test.ts —
 *   - `../db/queries/extensions` is mocked with an in-memory Map so we
 *     can read what `createExtension` was handed without standing up
 *     PGlite. (PGlite is single-writer; the brief explicitly forbids
 *     running two DB-touching test suites in parallel, so we route
 *     around the constraint by mocking the queries layer instead.)
 *   - `../extensions/registry` is mocked to a no-op reload.
 *
 * NOT mocked:
 *   - `loadManifest` — reads the real `ezcorp.config.ts` on disk.
 *   - `runEnvKeyLeakInstallGate` — runs against the real
 *     `clamp-permissions` predicate.
 *   - `computeChecksum` / `computePackageChecksums` — hash real files.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
} from "../extensions/types";

// ── Mock DB + registry (same shape installer.test.ts uses) ──────────

const mockExtensions = new Map<string, Record<string, unknown>>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: Record<string, unknown>) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) {
      if (ext.name === name) return ext;
    }
    return null;
  },
  updateExtension: async (id: string, data: Record<string, unknown>) => {
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: async () => {} }),
  },
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");
const { loadManifest } = await import("../extensions/loader");
const { EnvKeyLeakInstallError } = await import("../extensions/clamp-permissions");

// ── Constants ───────────────────────────────────────────────────

// Absolute path to the substack-pilot example so this test doesn't
// depend on the test runner's cwd. installFromLocal accepts an
// absolute path; the source row will be `local:<abs path>`.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSTACK_PILOT_PATH = resolve(
  __dirname,
  "../../docs/extensions/examples/substack-pilot",
);

// Granted permissions matching what the manifest declares + what the
// permission-prompt UI would emit on user approval. `network: ["*"]`
// matches the manifest. The grantedAt timestamps are required by the
// host's audit machinery; using a single now() is fine for tests.
const grantedPermissions: ExtensionPermissions = {
  storage: true,
  llm: {
    providers: ["anthropic", "openai"],
    maxCallsPerHour: 120,
    maxCallsPerDay: 600,
    maxTokensPerCall: 2048,
  },
  network: ["*"],
  shell: true,
  grantedAt: {
    storage: Date.now(),
    llm: Date.now(),
    network: Date.now(),
    shell: Date.now(),
  },
};

beforeEach(() => {
  mockExtensions.clear();
});

// ════════════════════════════════════════════════════════════════════
// installFromLocal — happy-path end-to-end through the real install path
// ════════════════════════════════════════════════════════════════════

describe("installFromLocal(substack-pilot) — happy path", () => {
  test("installs the extension with checksum, persists manifest + grants", async () => {
    const installed = await installFromLocal(
      SUBSTACK_PILOT_PATH,
      grantedPermissions,
      false /* enabled */,
    );

    // Identity + version pinned to the on-disk manifest. If the
    // extension ever bumps these we'll need to update; that's fine —
    // these assertions exist to catch silent name/version drift.
    expect(installed.name).toBe("substack-pilot");
    expect(installed.version).toBe("1.0.0");

    // Source string reflects the absolute path we passed in.
    expect(installed.source).toBe(`local:${SUBSTACK_PILOT_PATH}`);

    // Persisted manifest carries the entrypoint checksum (64 hex chars).
    // The installer computes this against index.ts; if the file is
    // missing or unreadable, computeChecksum throws and the install
    // fails — so seeing a checksum here is itself a check that the
    // entrypoint resolved correctly.
    //
    // schemaVersion is 3 in the persisted shape: loader.ts always
    // migrates v2 manifests through `migrateManifestV2ToV3` before
    // returning them, so the installer never sees v2 on the way to
    // createExtension. The `_inheritedFromV2: true` marker is the
    // breadcrumb that distinguishes a migrated v2 from a hand-authored v3.
    const manifest = installed.manifest as unknown as Record<string, unknown> & {
      checksum?: string;
    };
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest._inheritedFromV2).toBe(true);
    expect(typeof manifest.checksum).toBe("string");
    expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/);

    // Settings block survives the install round-trip — this is what the
    // brief calls "settings registration". There's no separate settings
    // table; the manifest carrying these three fields IS the registration
    // (the SettingsForm reads them off the installed extension row).
    const settings = manifest.settings as Record<string, unknown> | undefined;
    expect(settings).toBeDefined();
    expect(Object.keys(settings ?? {}).sort()).toEqual([
      "substack_publication_url",
      "substack_session_token",
      "substack_user_id",
    ]);

    // Each field has the shape SettingsForm expects: text type, label,
    // description, regex pattern. We don't re-validate the patterns
    // here (install-gate.test.ts already does that against the manifest
    // directly); we just confirm they survived through the installer.
    for (const key of [
      "substack_publication_url",
      "substack_session_token",
      "substack_user_id",
    ]) {
      const f = (settings as Record<string, Record<string, unknown>>)[key];
      expect(f?.type).toBe("text");
      expect(typeof f?.label).toBe("string");
      expect(typeof f?.pattern).toBe("string");
    }

    // Grants we passed in round-tripped through the DB write.
    const persistedGrants = installed.grantedPermissions as ExtensionPermissions;
    expect(persistedGrants.storage).toBe(true);
    expect(persistedGrants.shell).toBe(true);
    expect(persistedGrants.network).toEqual(["*"]);
    expect(persistedGrants.llm?.providers).toEqual(["anthropic", "openai"]);

    // checksumVerified comes from the installer's `true` literal for
    // local installs (it computed the checksum itself, so it can vouch
    // for it). enabled is the param we passed.
    expect(installed.checksumVerified).toBe(true);
    expect(installed.enabled).toBe(false);

    // Exactly one DB row created.
    expect(mockExtensions.size).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// installFromLocal — env-key-leak gate fires for credential-shaped names
// ════════════════════════════════════════════════════════════════════
//
// Regression guard through the REAL installer. install-gate.test.ts
// already proves `checkEnvKeyLeakInstallGate` rejects this name in
// isolation. This test goes one layer up: it synthesizes a manifest
// copy that adds the bad permission and feeds it through
// `installFromLocal` via the `preloadedManifest` option. That option
// exists specifically so callers can supply a pre-validated manifest
// without re-running `loadManifest` — perfect for a unit test that
// wants to swap out one field without writing a whole tmp dir.
//
// Why this matters beyond install-gate.test.ts:
//   - It proves `runEnvKeyLeakInstallGate` actually runs INSIDE the
//     installer flow (vs. being silently bypassed by an early-exit
//     refactor).
//   - It proves a refused install creates NO DB row — the gate fires
//     BEFORE `createExtension`, leaving zero residue.

describe("installFromLocal(substack-pilot) — env-leak gate refusal", () => {
  test("synthesized permissions.env: [SUBSTACK_SESSION_TOKEN] throws EnvKeyLeakInstallError", async () => {
    // Start from the real on-disk manifest, then mutate ONLY the env
    // permission. We deliberately use loadManifest to get the same
    // shape the installer would otherwise compute itself, so the only
    // difference between this test and the happy-path test above is
    // the synthesized env grant.
    const baseManifest = await loadManifest(SUBSTACK_PILOT_PATH);
    const evilManifest: ExtensionManifestV2 = {
      ...baseManifest,
      permissions: {
        ...(baseManifest.permissions ?? {}),
        env: ["SUBSTACK_SESSION_TOKEN"],
      },
    };

    expect(
      installFromLocal(
        SUBSTACK_PILOT_PATH,
        grantedPermissions,
        false,
        { preloadedManifest: evilManifest },
      ),
    ).rejects.toBeInstanceOf(EnvKeyLeakInstallError);

    // No DB row written — the gate fires BEFORE createExtension. This
    // is the guarantee install-gate.test.ts can't make on its own
    // because it doesn't exercise the installer flow.
    expect(mockExtensions.size).toBe(0);
  });

  test("benign env (no credential pattern) still installs", async () => {
    // Counterpart sanity check: confirms the gate's pattern matching
    // is the gating condition, not "any env entry at all". A name
    // like SUBSTACK_USER_ID doesn't match ENV_KEY_LEAK_PATTERN
    // (`_TOKEN$|_SECRET$|_KEY$|_PASSWORD$`), so the install should
    // succeed. Without this counterpart a future "block any env" PR
    // could pass the negative test above and silently break the
    // installer for legitimate uses.
    const baseManifest = await loadManifest(SUBSTACK_PILOT_PATH);
    const benignManifest: ExtensionManifestV2 = {
      ...baseManifest,
      permissions: {
        ...(baseManifest.permissions ?? {}),
        env: ["SUBSTACK_USER_ID"],
      },
    };

    const installed = await installFromLocal(
      SUBSTACK_PILOT_PATH,
      grantedPermissions,
      false,
      { preloadedManifest: benignManifest },
    );
    expect(installed.name).toBe("substack-pilot");
    expect(mockExtensions.size).toBe(1);
  });
});
