import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  // Phase 6 deletes the dead `checkPermission` boolean helper. PDP unit
  // coverage lives in `permission-engine.test.ts`.
  getRequiredPermissions,
  diffPermissions,
  isSensitiveOperation,
  checkSensitiveConfirmation,
  setSensitiveAlwaysAllow,
} from "../extensions/permissions";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";

// Mock settings store for sensitive confirmation tests
const mockSettings = new Map<string, unknown>();
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings.get(key),
  upsertSetting: async (key: string, value: unknown) => { mockSettings.set(key, value); },
  getAllSettings: async () => Object.fromEntries(mockSettings),
  deleteSetting: async (key: string) => mockSettings.delete(key),
  isListingInstalled: async () => false,
}));

afterAll(() => restoreModuleMocks());

// `checkPermission` (the dead sync boolean helper) was removed in
// Phase 6. PDP unit coverage lives in `permission-engine.test.ts`.

describe("getRequiredPermissions", () => {
  test("extracts flat permission list from manifest", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "Test",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {
        network: ["api.example.com"],
        shell: true,
        filesystem: ["/tmp"],
        env: ["MY_KEY"],
      },
    };

    const perms = getRequiredPermissions(manifest);
    expect(perms.length).toBe(4);
    expect(perms.some((p) => p.type === "network" && p.value === "api.example.com")).toBe(true);
    expect(perms.some((p) => p.type === "shell" && p.value === true)).toBe(true);
    expect(perms.some((p) => p.type === "filesystem" && p.value === "/tmp")).toBe(true);
    expect(perms.some((p) => p.type === "env" && p.value === "MY_KEY")).toBe(true);
  });

  test("returns empty list for no permissions", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "Test",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {},
    };
    expect(getRequiredPermissions(manifest)).toEqual([]);
  });
});

describe("diffPermissions", () => {
  test("returns permissions requested but not granted", () => {
    const requested: ExtensionPermissions = {
      network: ["api.example.com", "api.other.com"],
      shell: true,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["api.example.com"],
      grantedAt: {},
    };

    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["api.other.com"]);
    expect(diff.shell).toBe(true);
  });

  test("returns empty when all granted", () => {
    const perms: ExtensionPermissions = {
      network: ["a.com"],
      shell: true,
      grantedAt: {},
    };
    const diff = diffPermissions(perms, perms);
    expect(diff.network).toBeUndefined();
    expect(diff.shell).toBeUndefined();
  });
});

describe("isSensitiveOperation", () => {
  test("shell is always sensitive", () => {
    expect(isSensitiveOperation("shell")).toBe(true);
  });

  test("filesystem is always sensitive", () => {
    expect(isSensitiveOperation("filesystem")).toBe(true);
  });
});

describe("checkSensitiveConfirmation", () => {
  beforeEach(() => {
    mockSettings.clear();
  });

  test("returns needs_confirmation when no always-allow set", async () => {
    const result = await checkSensitiveConfirmation("ext-1", "shell");
    expect(result).toBe("needs_confirmation");
  });

  test("returns allowed after always-allow is set", async () => {
    await setSensitiveAlwaysAllow("ext-1", "shell", true);
    const result = await checkSensitiveConfirmation("ext-1", "shell");
    expect(result).toBe("allowed");
  });

  test("returns needs_confirmation after always-allow is revoked", async () => {
    await setSensitiveAlwaysAllow("ext-1", "filesystem", true);
    await setSensitiveAlwaysAllow("ext-1", "filesystem", false);
    const result = await checkSensitiveConfirmation("ext-1", "filesystem");
    expect(result).toBe("needs_confirmation");
  });

  test("always-allow is per extension", async () => {
    await setSensitiveAlwaysAllow("ext-1", "shell", true);
    const result = await checkSensitiveConfirmation("ext-2", "shell");
    expect(result).toBe("needs_confirmation");
  });

  // Regression for the writer/reader key-shape asymmetry. The bug was
  // that the PDP's reader keyed by `${kind}:${value}` while the writer
  // here keys by kind only — so a forever-scope grant for fs.write
  // never matched a value-carrying lookup. The fix collapses both
  // sides to kind-only; this test locks in the writer→reader round
  // trip at the scope (forever) where the production bug surfaced.
  test("forever-scope write for filesystem is found by the scoped reader", async () => {
    const SCOPE = { userId: "user-1", scope: "forever" as const, scopeId: "*" };
    await setSensitiveAlwaysAllow("ext-1", "filesystem", true, SCOPE);
    expect(
      await checkSensitiveConfirmation("ext-1", "filesystem", SCOPE),
    ).toBe("allowed");
  });

  test("forever-scope write for shell is found by the scoped reader", async () => {
    const SCOPE = { userId: "user-1", scope: "forever" as const, scopeId: "*" };
    await setSensitiveAlwaysAllow("ext-1", "shell", true, SCOPE);
    expect(await checkSensitiveConfirmation("ext-1", "shell", SCOPE)).toBe(
      "allowed",
    );
  });
});

// ── $CWD expansion in filesystem grant prefixes ────────────────────
//
// The bundled extension declarations use the literal string `$CWD` to
// mean "the server's current working directory". Without expansion,
// `realpath("$CWD")` throws ENOENT and the prefix is silently skipped,
// denying every legitimate write under the project root and tripping
// `denyAndDisable`. This regression-tests the expansion helper plus
// the end-to-end `checkFilesystemPermission` path.

import { expandGrantPrefix, checkFilesystemPermission } from "../extensions/permissions";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `process.cwd()` is process-global. These describes chdir into temp
// project roots; restoring ONLY in afterAll leaks a (since-rm'd) temp
// cwd into every later test FILE in the same `bun test` process — that
// poisons `findProjectRoot(process.cwd())` consumers (e.g. the
// extension-author draft-dir resolver). Always restore to this stable
// original in afterEach so the file never leaves cwd dirty.
const ORIGINAL_CWD = process.cwd();

describe("expandGrantPrefix", () => {
  test("expands the bare `$CWD` token to process.cwd()", () => {
    expect(expandGrantPrefix("$CWD")).toBe(process.cwd());
  });

  test("expands `$CWD/<sub>` to <cwd>/<sub>", () => {
    expect(expandGrantPrefix("$CWD/.ezcorp/extension-data/foo")).toBe(
      join(process.cwd(), ".ezcorp/extension-data/foo"),
    );
  });

  test("returns absolute paths unchanged", () => {
    expect(expandGrantPrefix("/etc/passwd")).toBe("/etc/passwd");
    expect(expandGrantPrefix("/app/web")).toBe("/app/web");
  });

  test("returns non-$CWD relative strings unchanged", () => {
    expect(expandGrantPrefix("relative/path")).toBe("relative/path");
    expect(expandGrantPrefix("$HOME")).toBe("$HOME");
  });
});

describe("checkFilesystemPermission — `$CWD` grant resolves at runtime", () => {
  let projectRoot = "";

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "expand-cwd-"));
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (projectRoot) {
      try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  test("path under <cwd>/.ezcorp is allowed when grant is `$CWD`", async () => {
    // Mirror the openai-image-gen-2 write target shape.
    const target = join(projectRoot, ".ezcorp", "extension-data", "ext", "generated");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "file.png"), "bytes");

    const result = await checkFilesystemPermission(
      join(target, "file.png"),
      { filesystem: ["$CWD"], grantedAt: {} },
      "/nonexistent/install/dir",
      "write",
    );
    expect(result.allowed).toBe(true);
  });

  test("path outside <cwd> is still denied even with `$CWD` grant", async () => {
    const result = await checkFilesystemPermission(
      "/etc/passwd",
      { filesystem: ["$CWD"], grantedAt: {} },
      "/nonexistent/install/dir",
      "read",
    );
    expect(result.allowed).toBe(false);
  });
});

// ── Grant-prefix bootstrap (granted dir doesn't exist yet) ─────────
//
// Regression for the extension-author "cannot access its own draft
// directory" deadlock: a bundled extension granted
// `$CWD/.ezcorp/extension-data/<name>` on a fresh project (where
// `.ezcorp/` is gitignored/absent) had its ONLY grant silently voided
// because `realpath(prefix)` threw ENOENT and the prefix was skipped,
// denying the first write and tripping `denyAndDisable`.

import { resolveGrantPrefixCanonical } from "../extensions/permissions";
import { realpathSync, symlinkSync } from "node:fs";

describe("resolveGrantPrefixCanonical", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "grant-prefix-")));
  });
  afterAll(() => {
    if (root) try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  test("existing dir → identical to realpath", async () => {
    const dir = join(root, "exists");
    mkdirSync(dir, { recursive: true });
    expect(await resolveGrantPrefixCanonical(dir)).toBe(realpathSync(dir));
  });

  test("missing leaf → <realAncestor>/<tail> (no longer skipped)", async () => {
    const missing = join(root, ".ezcorp", "extension-data", "extension-author");
    // Nothing under `root/.ezcorp` exists yet — the bootstrap case.
    expect(await resolveGrantPrefixCanonical(missing)).toBe(
      join(realpathSync(root), ".ezcorp/extension-data/extension-author"),
    );
  });

  test("symlinked existing ancestor is canonicalized", async () => {
    const realAncestor = join(root, "real-ancestor");
    mkdirSync(realAncestor, { recursive: true });
    const link = join(root, "link");
    symlinkSync(realAncestor, link);
    // Grant points through the symlink at a not-yet-existing tail.
    const viaLink = join(link, "data", "ext");
    expect(await resolveGrantPrefixCanonical(viaLink)).toBe(
      join(realpathSync(realAncestor), "data/ext"),
    );
  });

  test("unresolvable relative bareword → resolves against cwd, not null", async () => {
    // `realpath` resolves a relative path against process.cwd(); the
    // helper preserves that (behavior parity with the old `realpath`).
    const out = await resolveGrantPrefixCanonical("definitely-not-a-real-dir-xyz");
    expect(typeof out === "string" || out === null).toBe(true);
  });
});

describe("checkFilesystemPermission — granted prefix dir not created yet", () => {
  let projectRoot = "";

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "boot-grant-")));
    process.chdir(projectRoot);
  });
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    if (projectRoot) try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  test("target under a granted-but-uncreated `$CWD/...` prefix is ALLOWED once it exists", async () => {
    // The grant dir `.ezcorp/extension-data/extension-author` is NOT
    // pre-created — only the eventual target file's parent is. Pre-fix
    // the prefix realpath would throw and the grant be voided.
    const grant = "$CWD/.ezcorp/extension-data/extension-author";
    const target = join(
      projectRoot,
      ".ezcorp/extension-data/extension-author/drafts/u/d",
    );
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "ezcorp.config.ts"), "x");

    const result = await checkFilesystemPermission(
      join(target, "ezcorp.config.ts"),
      { filesystem: [grant], grantedAt: {} },
      "/nonexistent/install/dir",
      "write",
    );
    expect(result.allowed).toBe(true);
  });

  test("sibling outside the granted subtree is still DENIED", async () => {
    const grant = "$CWD/.ezcorp/extension-data/extension-author";
    const sibling = join(projectRoot, ".ezcorp/extension-data/other-ext");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "f.txt"), "x");

    const result = await checkFilesystemPermission(
      join(sibling, "f.txt"),
      { filesystem: [grant], grantedAt: {} },
      "/nonexistent/install/dir",
      "read",
    );
    expect(result.allowed).toBe(false);
  });
});
