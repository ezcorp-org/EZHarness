/**
 * Unit tests for `buildSandboxedMcpSpec` — audit finding #1 + Phase 7
 * MCP isolation.
 *
 * Pure-function scope: we don't spawn anything. We just assert that the
 * spec returned by the wrapper has the shape the StdioClientTransport
 * will hand to child_process.spawn — prlimit prefix, bounded env, no
 * process.env leak.
 *
 * The AF-1 regression test in `audit-regressions.test.ts` covers the
 * end-to-end spawn; this file is the cheap unit-level safety net.
 *
 * Phase 7: `buildSandboxedMcpSpec` is now async and returns
 * `{ spec, proxyHandle }`. When called WITHOUT a `ctx` (this test
 * file's contract) the function falls back to the pre-Phase-7 prlimit-
 * only spec — proxyHandle is null and no listener is started. The
 * Phase-7 test coverage (proxy unit + netns integration + fallback)
 * lives in dedicated files (`mcp-proxy.test.ts`, etc.).
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Audit mock — captures rows written by buildSandboxedMcpSpec for the
//    Plan 55-02 "bwrap tmpfs" describe block. Declared at module scope
//    so the mock survives across tests in the file; the pre-existing
//    describe blocks below don't pass `ctx` and never trigger audit
//    writes, so adding the mock is a no-op for them.
/** Poll until `pred()` holds (25ms steps, 3s cap). The netns-fallback audit
 *  rows are emitted fire-and-forget AFTER the spec builder returns; a fixed
 *  50ms settle was enough locally but deterministically too short on 2-core
 *  CI runners under coverage (PR #8 run 29589476463, shard 1: the
 *  "bubblewrap unavailable" row landed late and toBeDefined saw undefined,
 *  pooled AND isolated). Polling asserts the same eventually-lands
 *  invariant without the wall-clock guess; the follow-up expect() still
 *  fails with the original message if the row never arrives. */
async function waitForAudit(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 25));
  }
}

const AUDIT_CALLS: Array<{
  action: string;
  metadata: Record<string, unknown> | null;
}> = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    _target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    AUDIT_CALLS.push({ action, metadata: metadata ?? null });
    return `audit-${AUDIT_CALLS.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { buildSandboxedMcpSpec } from "../extensions/mcp-sandbox";
import {
  _resetProbeCacheForTests,
  _resetBwrapProbeCacheForTests,
  _setBwrapProbeOverridesForTests,
} from "../extensions/mcp-netns";
import {
  _resetTmpfsKillSwitchBootFlagForTests,
  _resetSeccompKillSwitchBootFlagForTests,
} from "../extensions/mcp-sandbox";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  McpServerStdio,
} from "../extensions/types";

afterAll(() => restoreModuleMocks());

function mcpManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "probe",
    version: "1.0.0",
    description: "",
    author: { name: "t" },
    kind: "mcp",
    mcpServers: [],
    permissions: {},
    ...overrides,
  };
}

const SAVED_ENV_KEYS = ["EZCORP_PERMITTED_HOSTS", "EZCORP_SHELL_ALLOWED", "AF1_SECRET"] as const;
function stashEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of SAVED_ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(stash: Record<string, string | undefined>) {
  for (const k of SAVED_ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k]!;
  }
}

describe("buildSandboxedMcpSpec — stdio wrap", () => {
  test("prepends prlimit with memory bounds before the original command", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio",
      name: "x",
      command: "/usr/bin/python3",
      args: ["-m", "my_mcp_server"],
    };
    const manifest = mcpManifest();
    const granted: ExtensionPermissions = { grantedAt: {} };

    const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, manifest, granted, "ext-1",
    );
    const wrapped = rawWrapped as McpServerStdio;

    // Phase 7: omitting `ctx` skips proxy startup — no handle returned.
    expect(proxyHandle).toBeNull();

    expect(wrapped.transport).toBe("stdio");
    expect(wrapped.command).toBe("prlimit");
    expect(wrapped.args?.[0]).toMatch(/^--rss=\d+$/);
    expect(wrapped.args?.[1]).toMatch(/^--as=\d+$/);
    // Original command + args preserved after prlimit flags
    const originalIdx = wrapped.args?.indexOf("/usr/bin/python3") ?? -1;
    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(wrapped.args?.slice(originalIdx)).toEqual(["/usr/bin/python3", "-m", "my_mcp_server"]);
  });

  test("uses manifest.resources.memory to set prlimit bytes", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio", name: "x", command: "/bin/true",
    };
    const manifest = mcpManifest({ resources: { memory: "1GB" } });
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, manifest, { grantedAt: {} }, "ext-mem",
    );
    const wrapped = rawWrapped as McpServerStdio;

    const expectedBytes = 1024 * 1024 * 1024;
    expect(wrapped.args?.[0]).toBe(`--rss=${expectedBytes}`);
    // `--as` (virtual address space) is sized with headroom above the rss
    // bound — JIT runtimes reserve far more virtual than resident memory,
    // so pinning `--as` to the rss bytes segfaults the child. It stays
    // FINITE (the AF-1 "no unlimited" invariant) but scales to 8× rss.
    expect(wrapped.args?.[1]).toBe(`--as=${expectedBytes * 8}`);
  });

  test("child env does NOT inherit EZCORP_PERMITTED_HOSTS from parent when network not granted", async () => {
    const stash = stashEnv();
    process.env.EZCORP_PERMITTED_HOSTS = "evil.example.com";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-net",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_PERMITTED_HOSTS).toBeUndefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("child env does NOT inherit EZCORP_SHELL_ALLOWED from parent", async () => {
    const stash = stashEnv();
    process.env.EZCORP_SHELL_ALLOWED = "1";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-shell",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_SHELL_ALLOWED).toBeUndefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("child env does NOT inherit arbitrary parent secrets", async () => {
    const stash = stashEnv();
    process.env.AF1_SECRET = "shh";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-no-secret",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.AF1_SECRET).toBeUndefined();
      // Subprocess survival: PATH is in the allowlist so binaries resolve.
      expect(wrapped.env?.PATH).toBeDefined();
    } finally {
      restoreEnv(stash);
    }
  });

  test("manifest-declared + granted env keys are forwarded (dual-gate)", async () => {
    const stash = stashEnv();
    process.env.AF1_SECRET = "from-host";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio", name: "x", command: "/bin/true",
      };
      const manifest = mcpManifest({
        permissions: { env: ["AF1_SECRET"] },
      });
      const granted: ExtensionPermissions = {
        grantedAt: {},
        env: ["AF1_SECRET"],
      };
      const { spec: rawWrapped } = await buildSandboxedMcpSpec(
        spec, manifest, granted, "ext-granted-env",
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.AF1_SECRET).toBe("from-host");
    } finally {
      restoreEnv(stash);
    }
  });

  test("granted network hosts become EZCORP_PERMITTED_HOSTS", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio", name: "x", command: "/bin/true",
    };
    const granted: ExtensionPermissions = {
      grantedAt: {},
      network: ["api.example.com", "cdn.example.com"],
    };
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), granted, "ext-net",
    );
    const wrapped = rawWrapped as McpServerStdio;
    expect(wrapped.env?.EZCORP_PERMITTED_HOSTS).toBe("api.example.com,cdn.example.com");
  });

  test("spec.env literal values (admin-approved in manifest) pass through", async () => {
    const spec: McpServerDefinition = {
      transport: "stdio",
      name: "x",
      command: "/bin/true",
      env: { MCP_MODE: "strict", MCP_LOG_LEVEL: "info" },
    };
    const { spec: rawWrapped } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-spec-env",
    );
    const wrapped = rawWrapped as McpServerStdio;
    expect(wrapped.env?.MCP_MODE).toBe("strict");
    expect(wrapped.env?.MCP_LOG_LEVEL).toBe("info");
  });
});

describe("buildSandboxedMcpSpec — non-stdio pass-through", () => {
  test("http spec is returned unchanged", async () => {
    const spec: McpServerDefinition = {
      transport: "http", name: "x", url: "https://example.com/mcp",
    };
    const { spec: wrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-http",
    );
    expect(wrapped).toBe(spec);
    expect(proxyHandle).toBeNull();
  });

  test("sse spec is returned unchanged", async () => {
    const spec: McpServerDefinition = {
      transport: "sse", name: "x", url: "https://example.com/sse",
    };
    const { spec: wrapped, proxyHandle } = await buildSandboxedMcpSpec(
      spec, mcpManifest(), { grantedAt: {} }, "ext-sse",
    );
    expect(wrapped).toBe(spec);
    expect(proxyHandle).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Plan 55-02 — bwrap tmpfs wrap (MCP-02 host-/tmp side-channel close)
//
// All three cases exercise the `ctx`-supplied production path so the
// `buildNetnsSpawnArgs` integration site sees the bwrap availability +
// kill-switch fields. The platform is forced to "linux" so the netns
// probe doesn't short-circuit to fallback on darwin CI; bwrap
// availability and kill-switch are driven via the test-only seam.
// ─────────────────────────────────────────────────────────────────────

const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: p,
    configurable: true,
    writable: false,
  });
}

describe("bwrap tmpfs", () => {
  beforeEach(() => {
    AUDIT_CALLS.length = 0;
    _resetProbeCacheForTests();
    _resetBwrapProbeCacheForTests();
    _resetTmpfsKillSwitchBootFlagForTests();
    delete process.env.EZCORP_MCP_STAGE1_TMPFS;
  });

  test("bwrap available + ctx provided → spawn env includes EZCORP_MCP_BWRAP_ENABLED=1", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-bwrap-on", ctx,
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBe("1");

      // Audit settle.
      await new Promise((res) => setTimeout(res, 50));
      // NO "bubblewrap unavailable" row should have been emitted — bwrap is present.
      const unavailRow = AUDIT_CALLS.find(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "bubblewrap unavailable",
      );
      expect(unavailRow).toBeUndefined();
      // NO kill-switch row — env var unset.
      const killRow = AUDIT_CALLS.find(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "kill-switch: tmpfs disabled",
      );
      expect(killRow).toBeUndefined();

      await proxyHandle?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
    }
  });

  test("bwrap missing on Linux → no EZCORP_MCP_BWRAP_ENABLED + extra MCP_NETNS_FALLBACK row with reason='bubblewrap unavailable'", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => null,
      probeRunner: () => {
        throw new Error("probe should not run when binary missing");
      },
    });
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-bwrap-missing", ctx,
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBeUndefined();

      await waitForAudit(() =>
        AUDIT_CALLS.some(
          (c) =>
            c.action === "ext:mcp:netns-fallback" &&
            (c.metadata?.reason as string | undefined) === "bubblewrap unavailable",
        ),
      );
      const unavailRow = AUDIT_CALLS.find(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "bubblewrap unavailable",
      );
      expect(unavailRow).toBeDefined();
      expect(unavailRow?.metadata?.bwrapReason).toBe("missing binary: bwrap");

      await proxyHandle?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
    }
  });

  test("kill-switch EZCORP_MCP_STAGE1_TMPFS=0 → no EZCORP_MCP_BWRAP_ENABLED + one-time boot fallback row", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _resetTmpfsKillSwitchBootFlagForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    process.env.EZCORP_MCP_STAGE1_TMPFS = "0";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      // First spawn — boot row should fire.
      const { proxyHandle: h1, spec: rawWrapped1 } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-killswitch-1", ctx,
      );
      const wrapped1 = rawWrapped1 as McpServerStdio;
      expect(wrapped1.env?.EZCORP_MCP_BWRAP_ENABLED).toBeUndefined();

      // Second spawn — boot row should NOT fire again (one-time per process).
      const { proxyHandle: h2 } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-killswitch-2", ctx,
      );

      // Poll for the FIRST row's arrival (presence race, same as the
      // bubblewrap-unavailable site); the exactly-one invariant below keeps
      // guarding against a duplicate from the second spawn.
      await waitForAudit(() =>
        AUDIT_CALLS.some(
          (c) =>
            c.action === "ext:mcp:netns-fallback" &&
            (c.metadata?.reason as string | undefined) === "kill-switch: tmpfs disabled",
        ),
      );
      const killRows = AUDIT_CALLS.filter(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "kill-switch: tmpfs disabled",
      );
      expect(killRows.length).toBe(1);

      await h1?.stop();
      await h2?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      delete process.env.EZCORP_MCP_STAGE1_TMPFS;
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
      _resetTmpfsKillSwitchBootFlagForTests();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Plan 55-03 — seccomp log mode (MCP-03)
//
// Three cases mirror the bwrap-tmpfs block above:
//   1. bwrap + seccomp FD present → spawn env has EZCORP_MCP_BWRAP_SECCOMP_FD=3
//      AND wrapper.seccompFd is the injected FD value.
//   2. EZCORP_MCP_STAGE1_SECCOMP=0 → no FD env, one-time boot row with
//      reason='kill-switch: seccomp disabled'.
//   3. seccomp loader returns null (file missing) → no FD env, no
//      kill-switch row.
//
// The seccomp-loader is mocked at module scope so the FD presence is
// driven deterministically without touching the filesystem.
// ─────────────────────────────────────────────────────────────────────

let MOCK_SECCOMP_FD: number | null = null;
mock.module("../extensions/runtime/seccomp-loader", () => ({
  openSeccompBpfFd: () => MOCK_SECCOMP_FD,
  getSeccompBpfPath: () => "/app/src/extensions/mcp-seccomp.bpf",
}));

describe("seccomp log mode", () => {
  beforeEach(() => {
    AUDIT_CALLS.length = 0;
    _resetProbeCacheForTests();
    _resetBwrapProbeCacheForTests();
    _resetTmpfsKillSwitchBootFlagForTests();
    _resetSeccompKillSwitchBootFlagForTests();
    delete process.env.EZCORP_MCP_STAGE1_SECCOMP;
    delete process.env.EZCORP_MCP_STAGE1_TMPFS;
    MOCK_SECCOMP_FD = null;
  });

  test("bwrap available + seccompFd present → spawn env has EZCORP_MCP_BWRAP_SECCOMP_FD=3 and spec.seccompFd is the FD", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    MOCK_SECCOMP_FD = 42;  // synthetic FD value; we never actually spawn
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-seccomp-on", ctx,
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_MCP_BWRAP_SECCOMP_FD).toBe("3");
      expect(wrapped.seccompFd).toBe(42);

      await new Promise((res) => setTimeout(res, 30));
      // No kill-switch row (env var unset).
      const killRow = AUDIT_CALLS.find(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "kill-switch: seccomp disabled",
      );
      expect(killRow).toBeUndefined();

      await proxyHandle?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
      MOCK_SECCOMP_FD = null;
    }
  });

  test("kill-switch EZCORP_MCP_STAGE1_SECCOMP=0 → no SECCOMP_FD env + one-time boot row with reason='kill-switch: seccomp disabled'", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    MOCK_SECCOMP_FD = 42;
    process.env.EZCORP_MCP_STAGE1_SECCOMP = "0";
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      // First spawn — boot row should fire.
      const { proxyHandle: h1, spec: rawWrapped1 } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-seccomp-ks-1", ctx,
      );
      const wrapped1 = rawWrapped1 as McpServerStdio;
      expect(wrapped1.env?.EZCORP_MCP_BWRAP_SECCOMP_FD).toBeUndefined();
      expect(wrapped1.seccompFd ?? null).toBeNull();

      // Second spawn — boot row should NOT fire again (one-time-per-process).
      const { proxyHandle: h2 } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-seccomp-ks-2", ctx,
      );

      await new Promise((res) => setTimeout(res, 30));
      const killRows = AUDIT_CALLS.filter(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "kill-switch: seccomp disabled",
      );
      expect(killRows.length).toBe(1);

      await h1?.stop();
      await h2?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      delete process.env.EZCORP_MCP_STAGE1_SECCOMP;
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
      _resetSeccompKillSwitchBootFlagForTests();
      MOCK_SECCOMP_FD = null;
    }
  });

  test("seccomp BPF file missing (loader returns null) → no SECCOMP_FD env + no kill-switch row", async () => {
    setPlatform("linux" as NodeJS.Platform);
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    MOCK_SECCOMP_FD = null;  // mimic dev-host: docker build never ran
    try {
      const spec: McpServerDefinition = {
        transport: "stdio",
        name: "p",
        command: "/usr/bin/python3",
        args: ["-m", "x"],
      };
      const ctx = {
        engine: createStubPermissionEngine("allow-all"),
        conversationId: null,
        userId: null,
      };
      const { spec: rawWrapped, proxyHandle } = await buildSandboxedMcpSpec(
        spec, mcpManifest(), { grantedAt: {} }, "ext-seccomp-noblob", ctx,
      );
      const wrapped = rawWrapped as McpServerStdio;
      expect(wrapped.env?.EZCORP_MCP_BWRAP_SECCOMP_FD).toBeUndefined();
      expect(wrapped.seccompFd ?? null).toBeNull();

      await new Promise((res) => setTimeout(res, 30));
      // No kill-switch row — the env var is unset; the FD is simply unavailable.
      const killRow = AUDIT_CALLS.find(
        (c) =>
          c.action === "ext:mcp:netns-fallback" &&
          (c.metadata?.reason as string | undefined) === "kill-switch: seccomp disabled",
      );
      expect(killRow).toBeUndefined();

      // bwrap is still enabled — tmpfs wrap still applies; only seccomp is off.
      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBe("1");

      await proxyHandle?.stop();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
      _resetBwrapProbeCacheForTests();
      MOCK_SECCOMP_FD = null;
    }
  });
});
