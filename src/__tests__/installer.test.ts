/**
 * Focused gap coverage for src/extensions/installer.ts.
 *
 * Complementary to installer-coverage.test.ts + installer-v2.test.ts — this
 * file only covers branches NOT already exercised there:
 *
 *   1. SEC-5 (#12): manifest.name path-traversal rejection through
 *      installFromLocal. Installer must reject "../x", "/abs", "foo/bar",
 *      "..", ".hidden", and names longer than 64 chars before touching
 *      the filesystem. See manifest.ts NAME_REGEX.
 *   2. #9 regression: installFromGitHub must fail loudly when the final
 *      cp -r into data/extensions/<name> fails — no silent fallback, no
 *      DB row, error message includes src/dest/stderr.
 *   3. Fixture smoke tests — exercise the new installer-fixtures helpers
 *      end-to-end so fixture regressions surface even when no product
 *      test uses them directly.
 */

import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionPermissions } from "../extensions/types";
import {
  makeLocalPackage,
  makeGitRepo,
  makeTarball,
  buildGithubFetchStub,
} from "./helpers/installer-fixtures";

// ── Mock DB + registry (same shape installer-coverage.test.ts uses) ──

const mockExtensions = new Map<string, any>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
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
  updateExtension: async (id: string, data: any) => {
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

const { installFromLocal, installFromGitHub, installFromGit } = await import(
  "../extensions/installer"
);

const defaultPerms: ExtensionPermissions = {
  network: [],
  grantedAt: { network: Date.now() },
};

beforeEach(() => {
  mockExtensions.clear();
});

// ══════════════════════════════════════════════════════════════════════
// SEC-5 (#12): manifest.name path-traversal rejection via installFromLocal
// ══════════════════════════════════════════════════════════════════════
//
// Rationale: validateManifestV2 enforces NAME_REGEX + excludes ".." —
// but validator-level tests (manifest-v2.test.ts) don't prove the
// installer honors that rejection. These tests go through installFromLocal
// so a regression that bypasses loader→validator is caught. The fixture
// helpers preserve the name string verbatim (spread + JSON.stringify),
// so the installer sees the malicious value exactly as an attacker would
// author it in ezcorp.config.ts.

describe("installFromLocal — manifest.name traversal rejection (SEC-5)", () => {
  const EXPECTED = /name must match.*filesystem-safe.*no path separators/;

  // Attack strings the user (or an extension author) might craft to try
  // escaping data/extensions/. Each must be rejected with the same error.
  const traversalNames: Array<[string, string]> = [
    ["parent-relative", "../escape"],
    ["absolute path", "/absolute"],
    ["embedded slash", "foo/bar"],
    ["bare dots", ".."],
    ["hidden (leading dot)", ".hidden"],
    ["backslash separator", "foo\\bar"],
    ["URL-ish", "../../etc/passwd"],
  ];

  for (const [label, name] of traversalNames) {
    test(`rejects name=${JSON.stringify(name)} (${label})`, async () => {
      const pkg = makeLocalPackage({ name });
      try {
        await expect(installFromLocal(pkg.path, defaultPerms)).rejects.toThrow(
          EXPECTED,
        );
        // And no DB row was created for the attempted install.
        expect(mockExtensions.size).toBe(0);
      } finally {
        pkg.cleanup();
      }
    });
  }

  test("rejects name longer than 64 chars", async () => {
    const pkg = makeLocalPackage({ name: "a".repeat(65) });
    try {
      await expect(installFromLocal(pkg.path, defaultPerms)).rejects.toThrow(
        EXPECTED,
      );
      expect(mockExtensions.size).toBe(0);
    } finally {
      pkg.cleanup();
    }
  });

  test("accepts name exactly 64 chars (boundary)", async () => {
    // Regex is [a-z0-9][a-z0-9-_.]{0,63} — total 1 + 63 = 64.
    const name = "a".repeat(64);
    const pkg = makeLocalPackage({ name });
    try {
      const result = await installFromLocal(pkg.path, defaultPerms);
      expect(result.name).toBe(name);
    } finally {
      pkg.cleanup();
    }
  });

  test("accepts valid filesystem-safe name with dots and hyphens", async () => {
    // Confirms the regex permits the inner character class [a-z0-9-_.]
    // — so legitimate names like "my-ext.v2" still install. Guards against
    // an over-broad hardening regression.
    const pkg = makeLocalPackage({ name: "my-ext.v2_0" });
    try {
      const result = await installFromLocal(pkg.path, defaultPerms);
      expect(result.name).toBe("my-ext.v2_0");
    } finally {
      pkg.cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// extension npm-deps: install refusal when a declared dep can't resolve
// ══════════════════════════════════════════════════════════════════════
//
// Mirrors the env-key-leak install gate: an unresolvable third-party npm
// dependency REFUSES the install (verify-only v1) with the actionable
// formatNpmDepError message, and persists NO DB row. Resolution is from
// the install path — a tmpdir fixture never reaches the app node_modules,
// so a declared dep is always "missing" here (exactly the deploy-drift
// the live incident hit).

describe("installFromLocal — npm-dependency install refusal", () => {
  test("refuses an install whose declared npm dep can't be resolved", async () => {
    const pkg = makeLocalPackage({
      npmDependencies: { "nonexistent-pkg-xyz": "^1.0.0" },
    });
    try {
      await expect(installFromLocal(pkg.path, defaultPerms)).rejects.toThrow(
        /requires npm package\(s\) it cannot resolve: nonexistent-pkg-xyz@\^1\.0\.0 \(missing\)/,
      );
      // No DB row for the refused install.
      expect(mockExtensions.size).toBe(0);
    } finally {
      pkg.cleanup();
    }
  });

  test("installs normally when no npm deps are declared (no regression)", async () => {
    const pkg = makeLocalPackage({ name: "no-npm-deps-ext" });
    try {
      const result = await installFromLocal(pkg.path, defaultPerms);
      expect(result.name).toBe("no-npm-deps-ext");
      expect(mockExtensions.size).toBe(1);
    } finally {
      pkg.cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// #9 regression: installFromGitHub fails loudly on cp -r failure
// ══════════════════════════════════════════════════════════════════════
//
// Before #9 the installer silently left the extension in the extraction
// tempdir when the final cp to data/extensions/<name> failed — later the
// tempdir was rm'd, leaving a broken DB row pointing at nothing. Post-fix
// the installer MUST throw "Failed to copy extension from ... to ...: ..."
// with the cp stderr, and MUST NOT create a DB row.
//
// We don't want to actually write to ./data/extensions during tests, so
// we patch Bun.spawnSync to intercept the cp call and force a non-zero
// exit — this exercises the exact error-handling branch at installer.ts
// lines 145-150 without touching the repo's real data/ directory.

describe("installFromGitHub — cp -r failure surfaces loud error (#9)", () => {
  const realSpawnSync = Bun.spawnSync;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (Bun as any).spawnSync = realSpawnSync;
    globalThis.fetch = realFetch;
  });

  test("throws 'Failed to copy' with stderr when cp exits non-zero", async () => {
    const tgz = await makeTarball({ name: "cp-fail-ext" });
    try {
      globalThis.fetch = buildGithubFetchStub({
        release: {
          tag_name: "v1.0.0",
          assets: [
            { name: "release.tar.gz", browser_download_url: "https://example.com/release.tar.gz" },
          ],
        },
        tarballBytes: tgz.bytes,
        tarballUrl: "https://example.com/release.tar.gz",
      });

      // Intercept the SECOND cp invocation (the final copy into
      // data/extensions/<name>). The first spawnSync call is `tar -xzf` for
      // extraction — we let that pass through. Any cp call we force to fail.
      const SPAWN_FAIL_STDERR = "cp: cannot create directory 'data/extensions/cp-fail-ext': Permission denied";
      (Bun as any).spawnSync = ((argv: string[], opts?: any) => {
        if (Array.isArray(argv) && argv[0] === "cp") {
          return {
            exitCode: 1,
            stdout: Buffer.from(""),
            stderr: Buffer.from(SPAWN_FAIL_STDERR),
            success: false,
          } as any;
        }
        return realSpawnSync(argv, opts);
      }) as typeof Bun.spawnSync;

      await expect(
        installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms),
      ).rejects.toThrow(
        /Failed to copy extension from .+ to .+: cp: cannot create directory.+Permission denied/,
      );

      // No DB row created for the failed install (the fix's real guarantee).
      expect(mockExtensions.size).toBe(0);
    } finally {
      tgz.cleanup();
    }
  });

  test("throws 'Failed to copy' with generic fallback when cp has empty stderr", async () => {
    // Covers the `stderr || "cp exited non-zero"` branch at installer.ts:148
    const tgz = await makeTarball({ name: "cp-silent-ext" });
    try {
      globalThis.fetch = buildGithubFetchStub({
        release: {
          tag_name: "v1.0.0",
          assets: [
            { name: "release.tar.gz", browser_download_url: "https://example.com/release.tar.gz" },
          ],
        },
        tarballBytes: tgz.bytes,
        tarballUrl: "https://example.com/release.tar.gz",
      });

      (Bun as any).spawnSync = ((argv: string[], opts?: any) => {
        if (Array.isArray(argv) && argv[0] === "cp") {
          return {
            exitCode: 1,
            stdout: Buffer.from(""),
            stderr: Buffer.from(""), // empty → exercises fallback
            success: false,
          } as any;
        }
        return realSpawnSync(argv, opts);
      }) as typeof Bun.spawnSync;

      await expect(
        installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms),
      ).rejects.toThrow(/Failed to copy extension.*cp exited non-zero/);
      expect(mockExtensions.size).toBe(0);
    } finally {
      tgz.cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Fixture smoke tests — ensure installer-fixtures helpers stay in sync
// ══════════════════════════════════════════════════════════════════════
//
// These are thin end-to-end smokes that exercise every public fixture
// helper against the real installer. If a helper drifts from installer
// expectations (e.g. loader.ts changes the config-file name), these
// fail loudly instead of lying dormant as broken scaffolding.

describe("installer-fixtures end-to-end smokes", () => {
  test("makeLocalPackage → installFromLocal succeeds", async () => {
    const pkg = makeLocalPackage({ name: "fx-local-smoke" });
    try {
      const result = await installFromLocal(pkg.path, defaultPerms);
      expect(result.name).toBe("fx-local-smoke");
      expect(result.source).toBe(`local:${pkg.path}`);
      expect(result.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      pkg.cleanup();
    }
  });

  test("makeGitRepo → installFromGit succeeds with tag", async () => {
    const repo = await makeGitRepo({
      manifestOverrides: { name: "fx-git-smoke" },
      tag: "v1.0.0",
    });
    const installBase = await mkdtemp(join(tmpdir(), "fx-installs-"));
    try {
      const source = `${repo.url}@v1.0.0`;
      const result = await installFromGit(source, defaultPerms, {
        extensionsDir: installBase,
      });
      expect(result.name).toBe("fx-git-smoke");
      expect(result.source).toBe(source);
      expect(result.installPath).toBe(join(installBase, "fx-git-smoke"));
    } finally {
      repo.cleanup();
      await rm(installBase, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("makeTarball + buildGithubFetchStub → installFromGitHub succeeds", async () => {
    // This smoke intentionally lets the real cp run (it will land in
    // ./data/extensions/fx-gh-smoke). We clean up after ourselves.
    const tgz = await makeTarball({ name: "fx-gh-smoke" });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = buildGithubFetchStub({
        release: {
          tag_name: "v1.0.0",
          assets: [
            { name: "release.tar.gz", browser_download_url: "https://example.com/release.tar.gz" },
          ],
        },
        tarballBytes: tgz.bytes,
        tarballUrl: "https://example.com/release.tar.gz",
      });

      const result = await installFromGitHub("fxuser/fxrepo@v1.0.0", defaultPerms);
      expect(result.name).toBe("fx-gh-smoke");
      expect(result.source).toContain("github:fxuser/fxrepo");
      expect(result.installPath).toBe(join("data", "extensions", "fx-gh-smoke"));
    } finally {
      globalThis.fetch = realFetch;
      tgz.cleanup();
      // Remove the extension directory the real cp created.
      await rm(join("data", "extensions", "fx-gh-smoke"), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  });

  test("buildGithubFetchStub rejects unmocked URLs with 404", async () => {
    // Guards against a leaky test silently hitting real github.com.
    const stub = buildGithubFetchStub({});
    const res = await stub("https://github.com/totally-unexpected");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("unmocked URL");
  });
});
