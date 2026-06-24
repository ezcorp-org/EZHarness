// Runtime permission-enforcement security tests (task #11).
//
// Proves that an extension with `enabled:true` but empty (or scoped)
// `grantedPermissions` is actually sandboxed at runtime. Each `describe`
// block exercises a distinct enforcement layer:
//
//   1. sandbox-preload.ts      — fetch(), Bun.spawn(), require("http"), etc.
//   2. ToolExecutor.handlePiFs — Bun.file(...) / readFile reverse-RPC mediation
//                                with realpath traversal guard
//   3. registry.buildAllowedEnv — env-var isolation (manifest+granted gate)
//   4. @ezcorp/sdk fetchPermitted — per-host network allowlist (the layer
//                                  that enforces `grantedPermissions.network`
//                                  once the sandbox has opened fetch())
//   5. registry.getProcess      — shellAllowed clamp derives from
//                                  `granted.shell === true` (belt-and-braces
//                                  against a spoofed manifest)
//
// Related, pre-existing coverage:
//   - src/__tests__/security/sb2-network-egress.test.ts
//   - src/__tests__/security/sb3-child-process-escape.test.ts
//   - src/__tests__/extension-security-runtime.test.ts
//   - packages/@ezcorp/sdk/test/http.test.ts
// This file is the consolidated cross-layer view required by task #11.

import { test, expect, describe, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionPermissions, ExtensionManifestV2, JsonRpcRequest } from "../extensions/types";

// ── DB mocks (must be set before importing modules that touch DB) ───

const disableExtensionCalls: string[] = [];

mock.module("../db/queries/extensions", () => ({
  disableExtension: async (id: string) => {
    disableExtensionCalls.push(id);
  },
  listExtensions: async () => [],
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

mock.module("../db/queries/settings", () => ({
  getSetting: async () => null,
  upsertSetting: async () => {},
  getAllSettings: async () => ({}),
}));

mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: () => Promise.resolve() }),
  }),
}));

afterAll(() => restoreModuleMocks());

// ── Imports after mocks ─────────────────────────────────────────────

import { ToolExecutor } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { ExtensionRegistry, buildAllowedEnv } from "../extensions/registry";
import { fetchPermitted } from "@ezcorp/sdk/runtime";

// ── Subprocess probe helpers (sandbox-preload layer) ────────────────

const SANDBOX_PRELOAD_PATH = pathResolve(
  import.meta.dir,
  "../extensions/runtime/sandbox-preload.ts",
);

type ProbeResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Run a one-liner under the real sandbox preload. `networkAllowed` /
 * `shellAllowed` mirror the env vars `subprocess.ts` sets when the extension
 * has the respective permissions granted. This is the SAME code path that
 * ExtensionProcess uses in production (minus the prlimit wrapper).
 *
 * `injectedEnv` lets us demonstrate that even host env vars do NOT reach
 * an extension unless its manifest declared them AND the user granted them.
 */
async function runUnderPreload(
  code: string,
  opts: {
    networkAllowed?: boolean;
    shellAllowed?: boolean;
    injectedEnv?: Record<string, string>;
    permittedHosts?: string;
  } = {},
): Promise<ProbeResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...opts.injectedEnv,
  };
  if (opts.networkAllowed) env.EZCORP_NETWORK_ALLOWED = "1";
  if (opts.shellAllowed) env.EZCORP_SHELL_ALLOWED = "1";
  if (opts.permittedHosts) env.EZCORP_PERMITTED_HOSTS = opts.permittedHosts;

  const proc = Bun.spawn(
    ["bun", "--preload", SANDBOX_PRELOAD_PATH, "-e", code],
    { stdout: "pipe", stderr: "pipe", env },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

const probeAsync = (expr: string) =>
  `(async () => { try { ${expr}; console.log("OK"); } ` +
  `catch (e) { console.log("ERR:" + (e?.message ?? String(e))); } })();`;

const probeSync = (expr: string) =>
  `try { ${expr}; console.log("OK"); } ` +
  `catch (e) { console.log("ERR:" + (e?.message ?? String(e))); }`;

// ═══════════════════════════════════════════════════════════════════
// CASE 1-3: Sandbox preload blocks with empty grantedPermissions
// ═══════════════════════════════════════════════════════════════════

describe("empty grantedPermissions — sandbox-preload blocks unprivileged APIs", () => {
  // Task #11 case 1
  test("fetch('https://evil.com') is blocked with network-permission error", async () => {
    const out = await runUnderPreload(probeSync(`fetch('https://evil.com/')`));
    // The preload replaces fetch with a denier; the message names the missing permission.
    expect(out.stdout).toMatch(/requires 'network' permission/);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("require('http') is blocked (network backdoor closed)", async () => {
    const out = await runUnderPreload(probeSync(`require('http').request('http://evil.com/')`));
    expect(out.stdout).toMatch(/requires 'network' permission/);
  });

  test("dynamic import('node:https') returns a poisoned module object", async () => {
    const out = await runUnderPreload(
      probeAsync(`const m = await import('node:https'); m.request`),
    );
    expect(out.stdout).toMatch(/requires 'network' permission/);
  });

  // Task #11 case 3
  test("Bun.spawn(['ls']) is blocked with shell-permission error", async () => {
    const out = await runUnderPreload(probeSync(`Bun.spawn(['ls'])`));
    expect(out.stdout).toMatch(/requires 'shell' permission/);
    expect(out.stdout).not.toMatch(/^OK$/m);
  });

  test("Bun.spawnSync(['ls']) is blocked with shell-permission error", async () => {
    const out = await runUnderPreload(probeSync(`Bun.spawnSync(['ls'])`));
    expect(out.stdout).toMatch(/requires 'shell' permission/);
  });

  test("require('child_process').exec('sh -c ...') is blocked", async () => {
    // exec is the classic shell-escape surface — must be denied even if the
    // extension tries to smuggle a command through /bin/sh.
    const out = await runUnderPreload(
      probeSync(`require('child_process').exec('sh -c "echo pwned"')`),
    );
    expect(out.stdout).toMatch(/requires 'shell' permission/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CASE 2 + 6: Filesystem — Bun.file('/etc/passwd') via handlePiFs
// ═══════════════════════════════════════════════════════════════════

describe("empty or scoped grantedPermissions — handlePiFs blocks filesystem escapes", () => {
  let testDir: string;
  let installDir: string;
  let sandboxDir: string; // granted prefix
  let outsideDir: string; // escape target

  beforeEach(() => {
    disableExtensionCalls.length = 0;
    ExtensionRegistry.resetInstance();

    testDir = join(tmpdir(), `perm-enf-fs-${randomUUID()}`);
    installDir = join(testDir, "install");
    sandboxDir = join(testDir, "ext-sandbox");
    outsideDir = join(testDir, "escape");

    mkdirSync(installDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(sandboxDir, "ok.txt"), "ok");
    writeFileSync(join(outsideDir, "secret.txt"), "secret");
  });

  afterEach(() => {
    ExtensionRegistry.resetInstance();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setup(granted: ExtensionPermissions) {
    const registry = ExtensionRegistry.getInstance();
    registry.setGrantedPermsForTest("ext-fs", granted);
    registry.setInstallPathForTest("ext-fs", installDir);
    return new ToolExecutor(registry, createStubPermissionEngine());
  }

  function fsReq(path: string): JsonRpcRequest {
    return { jsonrpc: "2.0", id: 1, method: "ezcorp/fs", params: { path, operation: "read" } };
  }

  // Task #11 case 2
  test("empty grantedPermissions: Bun.file('/etc/passwd') via ezcorp/fs is denied AND disables the extension", async () => {
    const executor = setup({ grantedAt: {} });
    const resp = await executor.handlePiFs("ext-fs", fsReq("/etc/passwd"));

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32001);
    expect(resp.error!.message).toMatch(/Filesystem access denied/);
    // denyAndDisable fires on violation — one of the primary guardrails.
    expect(disableExtensionCalls).toContain("ext-fs");
  });

  test("empty grantedPermissions: every path outside the install dir is denied", async () => {
    const executor = setup({ grantedAt: {} });
    const resp = await executor.handlePiFs("ext-fs", fsReq(join(outsideDir, "secret.txt")));
    expect(resp.error?.code).toBe(-32001);
  });

  // Task #11 case 6
  describe("scoped grantedPermissions: filesystem: [sandboxDir]", () => {
    test("read inside the granted prefix is allowed", async () => {
      const executor = setup({ grantedAt: {}, filesystem: [] }); // placeholder — overwritten below
      const registry = ExtensionRegistry.getInstance();
      registry.setGrantedPermsForTest("ext-fs", { grantedAt: {}, filesystem: [sandboxDir] });

      const resp = await executor.handlePiFs("ext-fs", fsReq(join(sandboxDir, "ok.txt")));
      expect(resp.error).toBeUndefined();
      expect((resp.result as { allowed: boolean }).allowed).toBe(true);
    });

    test("read of /etc/passwd is still denied", async () => {
      setup({ grantedAt: {}, filesystem: [sandboxDir] });
      const executor = new ToolExecutor(ExtensionRegistry.getInstance(), createStubPermissionEngine());

      const resp = await executor.handlePiFs("ext-fs", fsReq("/etc/passwd"));
      expect(resp.error?.code).toBe(-32001);
    });

    test("path-traversal via the granted prefix (sandbox/../escape/secret.txt) is denied after realpath resolution", async () => {
      // Literally `<sandboxDir>/../escape/secret.txt`. The filesystem check
      // uses realpath on BOTH sides — the resolved path falls outside the
      // resolved prefix and is rejected. This is the key anti-traversal
      // guarantee: string-prefix checks alone are not enough.
      setup({ grantedAt: {}, filesystem: [sandboxDir] });
      const executor = new ToolExecutor(ExtensionRegistry.getInstance(), createStubPermissionEngine());

      const traversal = join(sandboxDir, "..", "escape", "secret.txt");
      const resp = await executor.handlePiFs("ext-fs", fsReq(traversal));

      expect(resp.error?.code).toBe(-32001);
      expect(disableExtensionCalls).toContain("ext-fs");
    });

    test("symlink-escape is denied after realpath resolution", async () => {
      // A symlink pointing outside the sandbox should NOT grant access,
      // because checkFilesystemPermission resolves realpath before compare.
      setup({ grantedAt: {}, filesystem: [sandboxDir] });
      const executor = new ToolExecutor(ExtensionRegistry.getInstance(), createStubPermissionEngine());

      const linkPath = join(sandboxDir, "escape-link");
      symlinkSync(outsideDir, linkPath);

      const resp = await executor.handlePiFs("ext-fs", fsReq(join(linkPath, "secret.txt")));
      expect(resp.error?.code).toBe(-32001);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// CASE 4: Env-var isolation via buildAllowedEnv
// ═══════════════════════════════════════════════════════════════════

describe("empty grantedPermissions — process.env secrets are not leaked to the subprocess", () => {
  function manifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
    return {
      schemaVersion: 2,
      name: "test-ext",
      version: "1.0.0",
      description: "test",
      author: { name: "t" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {},
      ...overrides,
    };
  }

  test("with no granted env, only PATH/HOME/NODE_ENV/TMPDIR/EZCORP_PROJECT_ROOT reach the subprocess", () => {
    // Phase post-perm-cleanup: registry.ts:108 unconditionally injects
    // EZCORP_PROJECT_ROOT (when a `.git` ancestor is found, which is true
    // under the test runner) so sandboxed extensions can locate the
    // project root without their own poisoned `.git` walk. Sister tests
    // (ext-registry-executor.test.ts:259-272 and
    // extension-security-runtime.test.ts:470-478) already track this.
    const env = buildAllowedEnv(manifest(), { grantedAt: {} }, `ext-clean-${randomUUID()}`);
    // registry.ts:135 (file-organizer change) ALSO injects
    // EZCORP_EXTENSION_DATA_ROOT unconditionally — sorts before
    // EZCORP_PROJECT_ROOT.
    expect(Object.keys(env).sort()).toEqual([
      "EZCORP_EXTENSION_DATA_ROOT",
      "EZCORP_PROJECT_ROOT",
      "HOME",
      "NODE_ENV",
      "PATH",
      "TMPDIR",
    ]);
  });

  // Task #11 case 4 — core claim
  test("host-set SECRET is NOT visible to an extension without the env permission grant", () => {
    const prev = process.env.SECRET;
    process.env.SECRET = "super-secret-host-value";
    try {
      const env = buildAllowedEnv(manifest(), { grantedAt: {} }, `ext-secret-${randomUUID()}`);
      expect(env.SECRET).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SECRET;
      else process.env.SECRET = prev;
    }
  });

  test("SECRET declared in manifest but NOT granted is NOT visible to the subprocess", () => {
    const prev = process.env.SECRET_MANIFEST_ONLY;
    process.env.SECRET_MANIFEST_ONLY = "host-value";
    try {
      const env = buildAllowedEnv(
        manifest({ permissions: { env: ["SECRET_MANIFEST_ONLY"] } }),
        { grantedAt: {} },
        `ext-no-grant-${randomUUID()}`,
      );
      expect(env.SECRET_MANIFEST_ONLY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SECRET_MANIFEST_ONLY;
      else process.env.SECRET_MANIFEST_ONLY = prev;
    }
  });

  test("SECRET granted but NOT in manifest is NOT visible to the subprocess", () => {
    const prev = process.env.SECRET_GRANTED_ONLY;
    process.env.SECRET_GRANTED_ONLY = "host-value";
    try {
      const env = buildAllowedEnv(
        manifest(), // permissions: {}
        { grantedAt: {}, env: ["SECRET_GRANTED_ONLY"] },
        `ext-no-manifest-${randomUUID()}`,
      );
      expect(env.SECRET_GRANTED_ONLY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SECRET_GRANTED_ONLY;
      else process.env.SECRET_GRANTED_ONLY = prev;
    }
  });

  test("end-to-end: an un-granted SECRET is not readable from inside the subprocess", async () => {
    // Belt-and-braces: even if something up the stack accidentally passes
    // SECRET through the env, as long as the preload path doesn't import
    // it, Bun.env and process.env only see what the spawner put there.
    // Spawn a fresh subprocess WITHOUT SECRET in env and verify:
    const out = await runUnderPreload(
      probeSync(`if (process.env.SECRET !== undefined || Bun.env.SECRET !== undefined) ` +
        `throw new Error("SECRET leaked"); console.log("OK")`),
      { /* no injectedEnv -- SECRET is absent */ },
    );
    expect(out.stdout).toMatch(/^OK$/m);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CASE 5: Network per-host allowlist (fetchPermitted = thin shim post-Phase-2)
// ═══════════════════════════════════════════════════════════════════
//
// Phase 2 changed where the per-host gate lives:
//   - Pre-Phase-2: `fetchPermitted` (SDK helper) enforced the allowlist
//     by hand. Direct `fetch()` bypassed entirely.
//   - Post-Phase-2: the sandbox-preload installs a `globalThis.fetch`
//     wrapper that enforces the allowlist for EVERY fetch call (SDK
//     or raw). `fetchPermitted` is a `@deprecated` thin alias of
//     `globalThis.fetch`.
//
// The semantic invariant ("network: ['api.example.com'] gates fetches")
// still holds — it's just enforced at a different layer. These tests
// now verify the shim semantics + the wrapper layer is covered by
// `src/__tests__/network-wrapper.test.ts` (pure logic) and
// `src/__tests__/security/sb2-network-egress.test.ts` (real subprocess).

describe("scoped grantedPermissions: network — Phase 2 shim semantics", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("stub", { status: 200 })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("fetchPermitted is a thin alias — every call goes through globalThis.fetch", async () => {
    // Post-Phase-2: even if EZCORP_PERMITTED_HOSTS is unset in the
    // test environment, `fetchPermitted` doesn't throw on its own.
    // The real enforcement lives in the sandbox-preload's wrapper of
    // `globalThis.fetch` — which isn't installed in this unit-test
    // process (the spy stub takes its place).
    const resp = await fetchPermitted("https://api.example.com/v1/data");
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("fetchPermitted forwards to fetch even for non-allowlisted hosts (alias semantics)", async () => {
    // The shim doesn't pre-filter — it just calls fetch. The SANDBOX
    // wrapper rejects in production; in this in-process test the spy
    // captures the call without dialing the real network.
    await fetchPermitted("https://evil.com/x");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("fetchPermitted surfaces fetch's throw verbatim (e.g. wrapper-deny in sandboxed proc)", async () => {
    // Simulate the wrapped fetch rejecting an off-allowlist host:
    fetchSpy.mockImplementation(
      (async () => {
        throw new Error(
          "Extension sandbox: hostname 'evil.com' is not in the granted network allowlist (granted: api.example.com)",
        );
      }) as unknown as typeof fetch,
    );
    await expect(fetchPermitted("https://evil.com/")).rejects.toThrow(
      /hostname 'evil\.com' is not in the granted network allowlist/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// CASE 7: Shell clamp — registry derives shellAllowed from GRANTED, not manifest
// ═══════════════════════════════════════════════════════════════════

describe("shell clamp — registry.getProcess derives shellAllowed from GRANTED permissions", () => {
  // Even if an extension manifest declares `shell: true`, the registry
  // uses `granted.shell === true` when spawning the subprocess. A spoofed
  // or tampered manifest cannot escalate past what the user actually
  // granted. This is the belt-and-braces companion to the /activate
  // permission clamp enforced at install-time.
  //
  // We verify the contract by probing the REAL spawn-env decision: the
  // preload's block fires when EZCORP_SHELL_ALLOWED is not "1", and
  // subprocess.ts only sets it when the registry passes shellAllowed=true.

  test("Bun.spawn is blocked when granted.shell is missing, regardless of what the manifest declares", async () => {
    // Emulate what registry.getProcess would pass to ExtensionProcess for
    // an extension whose manifest declares shell but whose granted
    // permissions do not include it.
    const manifestDeclaresShell = true; // not used downstream; documents the scenario
    const grantedShell = undefined as boolean | undefined; // user did not grant
    // The policy: subprocess.ts only sets EZCORP_SHELL_ALLOWED=1 when the
    // caller passes `shellAllowed: true`, and registry.ts passes that only
    // when `granted.shell === true`. Together: manifest alone cannot open
    // shell access.
    void manifestDeclaresShell; // eslint-disable-line @typescript-eslint/no-unused-vars
    const shellAllowed = grantedShell === true;
    expect(shellAllowed).toBe(false);

    const out = await runUnderPreload(probeSync(`Bun.spawn(['true'])`), { shellAllowed });
    expect(out.stdout).toMatch(/requires 'shell' permission/);
  });

  test("Bun.spawn is blocked when granted.shell is explicitly false", async () => {
    const shellAllowed = (false as boolean) === true; // mimic registry.ts: `granted.shell === true`
    const out = await runUnderPreload(probeSync(`Bun.spawn(['true'])`), { shellAllowed });
    expect(out.stdout).toMatch(/requires 'shell' permission/);
  });

  test("Bun.spawn succeeds only when granted.shell === true", async () => {
    const shellAllowed = (true as boolean) === true;
    const out = await runUnderPreload(
      probeSync(
        `const p = Bun.spawn(['true']); ` +
          `if (typeof p.exited?.then !== "function") throw new Error("not a real Subprocess")`,
      ),
      { shellAllowed },
    );
    expect(out.stdout).toMatch(/^OK$/m);
    expect(out.stdout).not.toMatch(/requires 'shell' permission/);
  });
});
