/**
 * EZCORP_MCP_REQUIRE_SANDBOX — fail-closed sandbox enforcement tests.
 *
 * Pre-launch security finding: every fallback point in
 * `buildSandboxedMcpSpec` (netns probe failure, missing bwrap, Stage 2
 * veth/nft setup failure, Stage 1/2 kill-switches) FAILED OPEN — the
 * spawn proceeded at a weaker isolation stage with only a
 * fire-and-forget MCP_NETNS_FALLBACK audit row.
 *
 * Contract under test:
 *   - flag unset / not "1": behavior is EXACTLY the pre-flag fail-open
 *     degrade (spawn proceeds, fallback audit rows fire, no refusal)
 *   - flag === "1": ANY spawn that would degrade below full isolation
 *     (no-ctx prlimit-only leg, netns probe, bwrap probe, Stage 1/2
 *     kill-switches, veth capability probe, seccomp BPF blob missing,
 *     veth slot exhaustion, veth create / bridge-attach runtime
 *     failures) is REFUSED with an operator-actionable error naming
 *     the missing capability + the flag, plus one
 *     MCP_SANDBOX_REQUIRED_REFUSAL audit row
 *   - flag === "1" on a fully capable host: spawn proceeds normally
 *
 * The kernel probes shell out to the host, so `../extensions/mcp-netns`
 * is module-mocked (same pattern as preview-netns.test.ts) to drive
 * every capability branch deterministically on any host. The `ip`
 * runtime commands inside the veth-setup block go through a
 * `spyOn(Bun, "spawnSync")` seam (same pattern as the l5 oauth test's
 * `spyOn(Bun, "spawn")`).
 */

import { test, expect, describe, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";
import {
  openSync,
  closeSync,
  mkdtempSync,
  existsSync,
  realpathSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Audit mock — captures rows written by buildSandboxedMcpSpec ────
const auditCalls: Array<{
  userId: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
}> = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    _target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    auditCalls.push({ userId, action, metadata: metadata ?? null });
    return `audit-${auditCalls.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// ── mcp-netns mock — controllable capability state ─────────────────
// Covers every export consumed by the import graph under test
// (mcp-sandbox: probes + spawn-arg builder + veth allocator;
// registry: releaseVethSlot + initStage2).
const state = {
  netnsAvailable: true,
  netnsReason: undefined as string | undefined,
  bwrapAvailable: true,
  bwrapReason: undefined as string | undefined,
  vethAvailable: true,
  vethReason: undefined as string | undefined,
  slot: 1 as number | null,
  seccompFd: null as number | null,
  releasedSlots: [] as number[],
};

function resetState(): void {
  state.netnsAvailable = true;
  state.netnsReason = undefined;
  state.bwrapAvailable = true;
  state.bwrapReason = undefined;
  state.vethAvailable = true;
  state.vethReason = undefined;
  state.slot = 1;
  state.seccompFd = null;
  state.releasedSlots = [];
}

mock.module("../extensions/mcp-netns", () => ({
  probeNetnsAvailability: () =>
    state.netnsAvailable
      ? { available: true }
      : { available: false, reason: state.netnsReason },
  probeBwrapAvailability: () =>
    state.bwrapAvailable
      ? { available: true }
      : { available: false, reason: state.bwrapReason },
  probeVethCapability: () =>
    state.vethAvailable
      ? { available: true }
      : { available: false, reason: state.vethReason },
  buildNetnsSpawnArgs: (input: {
    origCommand: string;
    origArgs: readonly string[];
    launcherPath: string;
  }) =>
    state.netnsAvailable
      ? {
          command: "unshare",
          args: [
            "-U",
            "-m",
            "--map-root-user",
            "--",
            input.launcherPath,
            input.origCommand,
            ...input.origArgs,
          ],
          wrapped: true,
          bwrapAvailable: state.bwrapAvailable,
          bwrapReason: state.bwrapReason,
          tmpfsKillSwitchActive: process.env.EZCORP_MCP_STAGE1_TMPFS === "0",
          seccompFd: state.seccompFd,
          seccompKillSwitchActive: process.env.EZCORP_MCP_STAGE1_SECCOMP === "0",
        }
      : {
          command: input.origCommand,
          args: [...input.origArgs],
          wrapped: false,
          bwrapAvailable: state.bwrapAvailable,
          bwrapReason: state.bwrapReason,
          tmpfsKillSwitchActive: process.env.EZCORP_MCP_STAGE1_TMPFS === "0",
          seccompFd: state.seccompFd,
          seccompKillSwitchActive: process.env.EZCORP_MCP_STAGE1_SECCOMP === "0",
        },
  getDefaultLauncherPath: () => "/fake/mcp-launcher.sh",
  allocVethSlot: () => state.slot,
  releaseVethSlot: (slot: number) => {
    state.releasedSlots.push(slot);
  },
  computeVethMcpIp: (slot: number) => `10.42.0.${slot * 4 + 2}/30`,
  computeVethBridgeIp: (slot: number) => `10.42.0.${slot * 4 + 1}/30`,
  initStage2: async () => ({ ok: true }),
  isStage2DegradedAtBoot: () => false,
}));

import {
  buildSandboxedMcpSpec,
  _setConntrackOverridesForTests,
  _setProjectRootOverrideForTests,
  _setSandboxTierOverrideForTests,
} from "../extensions/mcp-sandbox";
import {
  assertJailArgsSafe,
  forbiddenDataDir,
} from "../extensions/preview-jail";
import { getDbMaskDirs } from "../db/connection";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

/** Reproduce the host's mask resolution: the real DB dir + backups
 *  (`getDbMaskDirs()`, independent of the project root) plus the
 *  `.ezcorp/data` convention path (only when a project root is known),
 *  deduped and `:`-joined. `undefined` when nothing is maskable. */
function expectedDataDirMask(jailRoot: string | null): string | undefined {
  const set = new Set<string>(getDbMaskDirs());
  if (jailRoot) set.add(forbiddenDataDir(jailRoot));
  return set.size > 0 ? [...set].join(":") : undefined;
}
import type {
  ExtensionManifestV2,
  McpServerDefinition,
  McpServerStdio,
} from "../extensions/types";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";

const REFUSAL_ACTION = EXT_AUDIT_ACTIONS.MCP_SANDBOX_REQUIRED_REFUSAL;

// ── Env hygiene — save / restore everything the gate reads ─────────
const ENV_KEYS = [
  "EZCORP_MCP_REQUIRE_SANDBOX",
  "EZCORP_MCP_STAGE1_TMPFS",
  "EZCORP_MCP_STAGE1_SECCOMP",
  "EZCORP_MCP_STAGE2_VETH",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

// Throwaway project root for the strict minimal-bind jail leg — keeps
// the `.ezcorp/extension-data/<name>` mkdir side effect out of the real
// repo working tree.
const JAIL_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ez-rs-jail-")));

beforeEach(() => {
  auditCalls.length = 0;
  resetState();
  for (const k of ENV_KEYS) delete process.env[k];
  // Skip the conntrack pressure pre-check deterministically.
  _setConntrackOverridesForTests({ exists: () => false });
  _setProjectRootOverrideForTests(JAIL_ROOT);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setConntrackOverridesForTests(null);
  _setProjectRootOverrideForTests(undefined);
  rmSync(JAIL_ROOT, { recursive: true, force: true });
  restoreModuleMocks();
});

function mcpManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "require-sandbox-probe",
    version: "1.0.0",
    description: "",
    author: { name: "t" },
    kind: "mcp",
    mcpServers: [],
    permissions: {},
  };
}

function stdioSpec(): McpServerDefinition {
  return {
    transport: "stdio",
    name: "p",
    command: "/usr/bin/python3",
    args: ["-m", "my_mcp_server"],
  };
}

function makeCtx() {
  return {
    engine: createStubPermissionEngine("allow-all"),
    conversationId: null,
    userId: "user-rs-1",
  };
}

function build(extensionId: string, withCtx = true) {
  return buildSandboxedMcpSpec(
    stdioSpec(),
    mcpManifest(),
    { grantedAt: {} },
    extensionId,
    withCtx ? makeCtx() : undefined,
  );
}

function refusalRows() {
  return auditCalls.filter((c) => c.action === REFUSAL_ACTION);
}

/** Fake the `ip ...` invocations inside the veth-setup block; every
 *  other Bun.spawnSync call falls through to the real implementation. */
function fakeIpSpawnSync(
  decide: (cmd: string[]) => { success: boolean; exitCode: number; stderr?: string },
) {
  const real = Bun.spawnSync.bind(Bun);
  return spyOn(Bun, "spawnSync").mockImplementation(((
    ...args: Parameters<typeof Bun.spawnSync>
  ) => {
    const opts = args[0] as { cmd?: string[] };
    if (Array.isArray(opts?.cmd) && opts.cmd[0] === "ip") {
      const r = decide(opts.cmd);
      return {
        success: r.success,
        exitCode: r.exitCode,
        stderr: new TextEncoder().encode(r.stderr ?? ""),
        stdout: new Uint8Array(),
      } as unknown as ReturnType<typeof Bun.spawnSync>;
    }
    return real(...args);
  }) as typeof Bun.spawnSync);
}

// ─────────────────────────────────────────────────────────────────────
describe("flag off — existing fail-open behavior preserved", () => {
  // These fail-open assertions expect the legacy prlimit-led spec
  // (`command === "prlimit"`). That holds on the bwrap/advisory tiers but
  // NOT landlock, which wraps the inner command with `bun <landlock-shim>`
  // (so `command === "bun"`). The assertions were implicitly relying on the
  // live host resolving to bwrap; on a setuid-bwrap host (e.g. NixOS) the
  // probe now correctly drops to landlock, flipping the command. Pin the
  // tier explicitly — like every other test in this file does — so the
  // fail-open path under test is deterministic regardless of host caps.
  beforeEach(() => {
    _setSandboxTierOverrideForTests("bwrap");
  });
  afterEach(() => {
    _setSandboxTierOverrideForTests(null);
  });

  test("netns unavailable → spawn proceeds with prlimit fallback + MCP_NETNS_FALLBACK, no refusal", async () => {
    state.netnsAvailable = false;
    state.netnsReason = "not linux";
    const { spec, proxyHandle } = await build("ext-rs-off-1");
    const wrapped = spec as McpServerStdio;

    expect(wrapped.command).toBe("prlimit");
    expect(wrapped.env?.HTTPS_PROXY).toBeDefined();
    const fallback = auditCalls.find(
      (c) => c.action === EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
    );
    expect(fallback).toBeDefined();
    expect(fallback?.metadata?.reason).toBe("not linux");
    expect(refusalRows()).toHaveLength(0);

    await proxyHandle?.stop();
  });

  test("bwrap unavailable → spawn proceeds at Stage 1 + 'bubblewrap unavailable' fallback row, no refusal", async () => {
    state.bwrapAvailable = false;
    state.bwrapReason = "missing binary: bwrap";
    state.vethAvailable = false; // keep the real `ip` commands out of the path
    const { spec, proxyHandle } = await build("ext-rs-off-2");
    const wrapped = spec as McpServerStdio;

    expect(wrapped.command).toBe("unshare");
    const bwrapRow = auditCalls.find(
      (c) =>
        c.action === EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK &&
        c.metadata?.reason === "bubblewrap unavailable",
    );
    expect(bwrapRow).toBeDefined();
    expect(bwrapRow?.metadata?.bwrapReason).toBe("missing binary: bwrap");
    expect(refusalRows()).toHaveLength(0);

    await proxyHandle?.stop();
  });

  test("flag set to a non-'1' value behaves as off (degraded spawn proceeds)", async () => {
    process.env.EZCORP_MCP_REQUIRE_SANDBOX = "0";
    state.netnsAvailable = false;
    state.netnsReason = "unshare probe exited 1";
    const { spec, proxyHandle } = await build("ext-rs-off-3");

    expect((spec as McpServerStdio).command).toBe("prlimit");
    expect(refusalRows()).toHaveLength(0);

    await proxyHandle?.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("flag on — degraded host is refused", () => {
  beforeEach(() => {
    process.env.EZCORP_MCP_REQUIRE_SANDBOX = "1";
  });

  test("ctx omitted (prlimit-only back-compat leg) → refused", async () => {
    await expect(build("ext-rs-noctx", false)).rejects.toThrow(
      /EZCORP_MCP_REQUIRE_SANDBOX=1.*PermissionEngine ctx/,
    );
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.metadata?.requiredCapability).toContain("PermissionEngine");
  });

  test("netns unavailable → refused naming unshare + the flag; no fallback row", async () => {
    state.netnsAvailable = false;
    state.netnsReason = "kernel.unprivileged_userns_clone=0";
    await expect(build("ext-rs-netns")).rejects.toThrow(
      /EZCORP_MCP_REQUIRE_SANDBOX=1.*user\+mount namespace isolation \(unshare\).*kernel\.unprivileged_userns_clone=0/,
    );
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.reason).toBe("kernel.unprivileged_userns_clone=0");
    expect(rows[0]?.metadata?.extensionName).toBe("require-sandbox-probe");
    // Refusal short-circuits BEFORE the netns audit row + proxy start.
    expect(
      auditCalls.find((c) => c.action === EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK),
    ).toBeUndefined();
  });

  test("bwrap unavailable → refused naming bubblewrap", async () => {
    state.bwrapAvailable = false;
    state.bwrapReason = "missing binary: bwrap";
    await expect(build("ext-rs-bwrap")).rejects.toThrow(
      /bubblewrap tmpfs sandbox \(bwrap\).*missing binary: bwrap/,
    );
    expect(refusalRows()[0]?.metadata?.reason).toBe("missing binary: bwrap");
  });

  test("veth capability unavailable → refused naming Stage 2 / CAP_NET_ADMIN", async () => {
    state.vethAvailable = false;
    state.vethReason = "stage2 degraded at boot";
    await expect(build("ext-rs-vethcap")).rejects.toThrow(
      /Stage 2 veth network isolation \(ip\/nft\/CAP_NET_ADMIN\).*stage2 degraded at boot/,
    );
    expect(refusalRows()[0]?.metadata?.reason).toBe("stage2 degraded at boot");
  });

  const KILL_SWITCHES: Array<{ env: string; capability: RegExp }> = [
    { env: "EZCORP_MCP_STAGE1_TMPFS", capability: /bubblewrap tmpfs sandbox/ },
    { env: "EZCORP_MCP_STAGE1_SECCOMP", capability: /seccomp BPF syscall filter/ },
    { env: "EZCORP_MCP_STAGE2_VETH", capability: /Stage 2 veth network isolation/ },
  ];
  for (const ks of KILL_SWITCHES) {
    test(`${ks.env}=0 kill-switch contradicts the flag → refused`, async () => {
      process.env[ks.env] = "0";
      await expect(build(`ext-rs-${ks.env}`)).rejects.toThrow(ks.capability);
      const rows = refusalRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata?.reason).toBe(`kill-switch active: ${ks.env}=0`);
    });
  }

  test("seccomp BPF blob missing (seccompFd null) → refused after proxy teardown", async () => {
    state.seccompFd = null; // dev host: mcp-seccomp.bpf absent
    await expect(build("ext-rs-seccomp-blob")).rejects.toThrow(
      /seccomp BPF syscall filter.*mcp-seccomp\.bpf absent or unreadable/,
    );
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.requiredCapability).toBe("seccomp BPF syscall filter");
  });

  test("veth slot exhausted → refused; opened seccomp FD is closed", async () => {
    state.slot = null;
    const fd = openSync("/dev/null", "r");
    state.seccompFd = fd;
    try {
      await expect(build("ext-rs-slot")).rejects.toThrow(
        /Stage 2 veth network isolation.*veth slot exhausted \(60 concurrent MCP cap\)/,
      );
      // The fail-closed teardown closed the FD — closing again must fail.
      expect(() => closeSync(fd)).toThrow();
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed by the guard — expected */
      }
    }
    expect(refusalRows()[0]?.metadata?.reason).toBe(
      "veth slot exhausted (60 concurrent MCP cap)",
    );
  });

  test("veth pair create fails at runtime → refused with the ip stderr", async () => {
    const fd = openSync("/dev/null", "r");
    state.seccompFd = fd;
    const spy = fakeIpSpawnSync(() => ({
      success: false,
      exitCode: 2,
      stderr: "RTNETLINK answers: Operation not permitted",
    }));
    try {
      await expect(build("ext-rs-veth-create")).rejects.toThrow(
        /veth pair create failed: RTNETLINK answers: Operation not permitted/,
      );
    } finally {
      spy.mockRestore();
      try {
        closeSync(fd);
      } catch {
        /* already closed by the guard — expected */
      }
    }
    expect(state.releasedSlots).toEqual([1]);
    expect(refusalRows()).toHaveLength(1);
  });

  test("project root unresolved → refused naming the filesystem jail (no data-dir exclusion possible)", async () => {
    _setProjectRootOverrideForTests(null);
    await expect(build("ext-rs-noroot")).rejects.toThrow(
      /minimal-bind filesystem jail \(project root\).*EZCORP_PROJECT_ROOT unresolved/,
    );
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.requiredCapability).toBe(
      "minimal-bind filesystem jail (project root)",
    );
    // Refusal short-circuits BEFORE the proxy start + netns audit row.
    expect(
      auditCalls.find((c) => c.action === EXT_AUDIT_ACTIONS.MCP_NETNS_CREATED),
    ).toBeUndefined();
  });

  test("jail bind-set build failure (work dir inside .ezcorp/data) → refused with the builder's reason", async () => {
    // Force the builder to fail closed: a manifest name crafted so the
    // extension-data work dir would be an ANCESTOR trick is impossible
    // (paths are joined under extension-data), so drive the failure via
    // a project root whose extension-data path collides with the data
    // dir through a symlink.
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const evilRoot = realpathSync(mkdtempSync(join(tmpdir(), "ez-rs-evil-")));
    mkdirSync(join(evilRoot, ".ezcorp", "data"), { recursive: true });
    // `.ezcorp/extension-data` → symlink into `.ezcorp/data`: the
    // canonicalize-before-assert step must reject the realpath.
    symlinkSync(
      join(evilRoot, ".ezcorp", "data"),
      join(evilRoot, ".ezcorp", "extension-data"),
    );
    _setProjectRootOverrideForTests(evilRoot);
    try {
      await expect(build("ext-rs-evil-workdir")).rejects.toThrow(
        /minimal-bind filesystem jail \(bwrap bind set\)/,
      );
      expect(refusalRows()).toHaveLength(1);
    } finally {
      rmSync(evilRoot, { recursive: true, force: true });
    }
  });

  test("bridge attach fails at runtime → refused naming the bridge", async () => {
    const fd = openSync("/dev/null", "r");
    state.seccompFd = fd;
    const spy = fakeIpSpawnSync((cmd) =>
      cmd.includes("master")
        ? { success: false, exitCode: 1, stderr: "Cannot find device br-ezcorp-mcp" }
        : { success: true, exitCode: 0 },
    );
    try {
      await expect(build("ext-rs-veth-attach")).rejects.toThrow(
        /veth bridge attach\/up failed \(br-ezcorp-mcp missing or down\)/,
      );
    } finally {
      spy.mockRestore();
      try {
        closeSync(fd);
      } catch {
        /* already closed by the guard — expected */
      }
    }
    expect(state.releasedSlots).toEqual([1]);
    expect(refusalRows()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase A3 (Seam C) — the minimal-bind fs-jail is now UNCONDITIONAL,
// tier-gated by the capability probe (no longer requires the
// EZCORP_MCP_REQUIRE_SANDBOX flag). On a bwrap-capable host the default
// posture activates EZCORP_MCP_FS_JAIL=1 + the pre-built minimal-bind
// argv (NO `--bind / /`) — but WITHOUT EZCORP_MCP_REQUIRE_SANDBOX=1, so
// the launcher's fail-closed raw-exec fallback is NOT armed. This
// replaces the legacy "mask-only" default leg the prior test encoded.
describe("default posture (flag off) — fs-jail is unconditional on a capable host", () => {
  test("bwrap-capable host → FS_JAIL=1 + minimal-bind argv, no REQUIRE_SANDBOX", async () => {
    _setSandboxTierOverrideForTests("bwrap");
    const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
    try {
      const { spec, proxyHandle } = await build("ext-rs-off-datadir");
      const wrapped = spec as McpServerStdio;

      // Unconditional fs-jail: routed to the launcher's exec-verbatim
      // minimal-bind branch (NO `--bind / /`).
      expect(wrapped.env?.EZCORP_MCP_FS_JAIL).toBe("1");
      // But NOT strict — the operator did not opt into fail-closed.
      expect(wrapped.env?.EZCORP_MCP_REQUIRE_SANDBOX).toBeUndefined();
      // The launcher payload is now the pre-built bwrap minimal-bind argv
      // (the launcher itself does `exec bwrap "$@"`, so the payload starts
      // with bwrap FLAGS, not the bare prlimit chain).
      const launcherIdx = wrapped.args!.indexOf("/fake/mcp-launcher.sh");
      const jailArgv = wrapped.args!.slice(launcherIdx + 1);
      expect(jailArgv).not.toEqual(["prlimit", ...jailArgv.slice(1)]);
      expect(jailArgv[0]).toMatch(/^--/); // bwrap flag, not "prlimit"
      // The minimal-bind argv must never expose the data dir nor root.
      expect(() => assertJailArgsSafe(jailArgv, JAIL_ROOT)).not.toThrow();
      // The original inner command is still present at the tail.
      expect(jailArgv).toContain("prlimit");
      // No refusal — non-strict, jail built cleanly.
      expect(refusalRows()).toHaveLength(0);

      await proxyHandle?.stop();
    } finally {
      spy.mockRestore();
      _setSandboxTierOverrideForTests(null);
    }
  });

  test("advisory tier (no Landlock/bwrap) → legacy masked path, no FS_JAIL", async () => {
    _setSandboxTierOverrideForTests("advisory");
    const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
    try {
      const { spec, proxyHandle } = await build("ext-rs-off-advisory");
      const wrapped = spec as McpServerStdio;

      // No usable tier → fall back to the legacy masked `--bind / /` path.
      expect(wrapped.env?.EZCORP_MCP_FS_JAIL).toBeUndefined();
      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBe("1");
      expect(wrapped.env?.EZCORP_MCP_DATA_DIR).toBe(expectedDataDirMask(JAIL_ROOT));
      expect(wrapped.env?.EZCORP_MCP_DATA_DIR).toContain(forbiddenDataDir(JAIL_ROOT));
      const launcherIdx = wrapped.args!.indexOf("/fake/mcp-launcher.sh");
      expect(wrapped.args!.slice(launcherIdx + 1, launcherIdx + 2)).toEqual(["prlimit"]);
      expect(refusalRows()).toHaveLength(0);

      await proxyHandle?.stop();
    } finally {
      spy.mockRestore();
      _setSandboxTierOverrideForTests(null);
    }
  });

  // Phase A3 GATE — landlock tier END-TO-END containment. With netns
  // unavailable the spec is UNWRAPPED, so buildSandboxedMcpSpec emits
  // `bun <landlock-shim> -- prlimit ... <cmd>` directly. We spawn that argv
  // for real and assert a sandboxed MCP process CANNOT read .ezcorp/data
  // but CAN read its own workspace. Skips where Landlock is unavailable.
  const LANDLOCK_ABI = (() => {
    try {
      // local require to avoid a top-level import cost on non-Linux
      const { probeLandlockAbi } = require("../extensions/sandbox/capability-probe");
      return probeLandlockAbi() ?? 0;
    } catch {
      return 0;
    }
  })();

  test.if(LANDLOCK_ABI >= 1)(
    "landlock tier → sandboxed MCP DENIED reading .ezcorp/data, ALLOWED its workspace",
    async () => {
      _setSandboxTierOverrideForTests("landlock");
      state.netnsAvailable = false; // force the unwrapped (directly-spawnable) argv
      const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
      try {
        // The MCP's own workspace + a planted secret under .ezcorp/data.
        const workDir = join(
          JAIL_ROOT,
          ".ezcorp",
          "extension-data",
          "require-sandbox-probe",
        );
        mkdirSync(workDir, { recursive: true });
        writeFileSync(join(workDir, "ws.txt"), "WORKSPACE-OK");
        const dataDir = join(JAIL_ROOT, ".ezcorp", "data");
        mkdirSync(dataDir, { recursive: true });
        const secret = join(dataDir, "jwt-secret.txt");
        writeFileSync(secret, "TOP-SECRET");

        // Build a spec whose INNER command is `cat <secret>` → must be denied.
        const denySpec: McpServerDefinition = {
          transport: "stdio",
          name: "p",
          command: "cat",
          args: [secret],
        };
        const denyBuilt = await buildSandboxedMcpSpec(
          denySpec,
          mcpManifest(),
          { grantedAt: {} },
          "ext-ll-deny",
          makeCtx(),
        );
        const denyWrapped = denyBuilt.spec as McpServerStdio;
        // The argv is the shim-wrapped prlimit chain.
        expect(denyWrapped.command).toBe("bun");
        expect(denyWrapped.args![0]).toMatch(/landlock-shim\.ts$/);
        expect(denyWrapped.env?.EZCORP_LANDLOCK_SPEC).toBeDefined();
        // The spec must NOT grant anything under .ezcorp/data.
        const llSpec = JSON.parse(denyWrapped.env!.EZCORP_LANDLOCK_SPEC!);
        for (const p of [...llSpec.ro, ...llSpec.rw]) {
          expect(p.startsWith(dataDir)).toBe(false);
        }
        const pDeny = Bun.spawnSync(
          [denyWrapped.command, ...(denyWrapped.args ?? [])],
          { env: { ...process.env, ...denyWrapped.env }, stdout: "pipe", stderr: "pipe" },
        );
        expect(pDeny.exitCode).not.toBe(0);
        expect(pDeny.stderr.toString().toLowerCase()).toContain("permission denied");
        await denyBuilt.proxyHandle?.stop();

        // And a read of the workspace file SUCCEEDS under the same jail.
        const allowSpec: McpServerDefinition = {
          transport: "stdio",
          name: "p",
          command: "cat",
          args: [join(workDir, "ws.txt")],
        };
        const allowBuilt = await buildSandboxedMcpSpec(
          allowSpec,
          mcpManifest(),
          { grantedAt: {} },
          "ext-ll-allow",
          makeCtx(),
        );
        const allowWrapped = allowBuilt.spec as McpServerStdio;
        const pAllow = Bun.spawnSync(
          [allowWrapped.command, ...(allowWrapped.args ?? [])],
          { env: { ...process.env, ...allowWrapped.env }, stdout: "pipe", stderr: "pipe" },
        );
        expect(pAllow.exitCode).toBe(0);
        expect(pAllow.stdout.toString()).toContain("WORKSPACE-OK");
        await allowBuilt.proxyHandle?.stop();
      } finally {
        spy.mockRestore();
        _setSandboxTierOverrideForTests(null);
      }
    },
  );

  test("landlock tier + netns-wrapped → shim inserted after the launcher path", async () => {
    _setSandboxTierOverrideForTests("landlock");
    state.netnsAvailable = true; // wrapped: unshare -U -m -- launcher prlimit ...
    const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
    try {
      const { spec, proxyHandle } = await build("ext-ll-wrapped");
      const wrapped = spec as McpServerStdio;
      // No bwrap fs-jail on the landlock tier.
      expect(wrapped.env?.EZCORP_MCP_FS_JAIL).toBeUndefined();
      // Landlock spec threaded.
      expect(wrapped.env?.EZCORP_LANDLOCK_SPEC).toBeDefined();
      // The shim is inserted immediately after the launcher path so the
      // inner command runs jailed inside the namespace.
      const launcherIdx = wrapped.args!.indexOf("/fake/mcp-launcher.sh");
      expect(wrapped.args![launcherIdx + 1]).toBe("bun");
      expect(wrapped.args![launcherIdx + 2]).toMatch(/landlock-shim\.ts$/);
      expect(wrapped.args![launcherIdx + 3]).toBe("--");
      // The original inner command (prlimit chain) follows the shim.
      expect(wrapped.args![launcherIdx + 4]).toBe("prlimit");
      await proxyHandle?.stop();
    } finally {
      spy.mockRestore();
      _setSandboxTierOverrideForTests(null);
    }
  });

  test("project root unresolved → spawn proceeds; DB-dir mask still applies (only the .ezcorp/data convention part drops)", async () => {
    _setProjectRootOverrideForTests(null);
    const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
    try {
      const { spec, proxyHandle } = await build("ext-rs-off-noroot");
      const wrapped = spec as McpServerStdio;

      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBe("1");
      // The real DB data dir is resolved independently of the project
      // root, so it is masked even when the root is unknown.
      expect(wrapped.env?.EZCORP_MCP_DATA_DIR).toBe(expectedDataDirMask(null));
      expect(refusalRows()).toHaveLength(0);

      await proxyHandle?.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("flag on — fully capable host spawns normally", () => {
  test("all isolation legs available → spec built, no refusal row", async () => {
    process.env.EZCORP_MCP_REQUIRE_SANDBOX = "1";
    const fd = openSync("/dev/null", "r");
    state.seccompFd = fd;
    const spy = fakeIpSpawnSync(() => ({ success: true, exitCode: 0 }));
    try {
      const { spec, proxyHandle } = await build("ext-rs-full");
      const wrapped = spec as McpServerStdio;

      expect(wrapped.command).toBe("unshare");
      expect(wrapped.env?.EZCORP_MCP_BWRAP_ENABLED).toBe("1");
      expect(wrapped.env?.EZCORP_MCP_BWRAP_SECCOMP_FD).toBe("3");
      expect(wrapped.env?.EZCORP_MCP_STAGE2_VETH_ENABLED).toBe("1");
      expect(wrapped.seccompFd).toBe(fd);
      expect(wrapped._internal_vethSetup).not.toBeNull();

      // CRITICAL fs-confinement fix — strict leg: the launcher payload
      // (everything after the launcher path) is the COMPLETE minimal-bind
      // bwrap argv, exec'd verbatim via EZCORP_MCP_FS_JAIL=1.
      expect(wrapped.env?.EZCORP_MCP_FS_JAIL).toBe("1");
      expect(wrapped.env?.EZCORP_MCP_REQUIRE_SANDBOX).toBe("1");
      expect(wrapped.env?.EZCORP_MCP_DATA_DIR).toBe(expectedDataDirMask(JAIL_ROOT));
      const launcherIdx = wrapped.args!.indexOf("/fake/mcp-launcher.sh");
      expect(launcherIdx).toBeGreaterThan(0);
      const jailArgv = wrapped.args!.slice(launcherIdx + 1);
      // No root bind, nothing under .ezcorp/data — the unit-tested
      // invariant guard accepts the argv.
      expect(jailArgv.join(" ")).not.toContain("--bind / /");
      expect(() => assertJailArgsSafe(jailArgv, JAIL_ROOT)).not.toThrow();
      // Minimal-bind shape: ro system binds, private tmpfs, seccomp FD 3,
      // host net/pid namespaces shared (no --unshare-*), and the inner
      // prlimit chain after the `--` terminator.
      expect(jailArgv).toContain("--ro-bind");
      expect(jailArgv).toContain("--tmpfs");
      expect(jailArgv[jailArgv.indexOf("--seccomp") + 1]).toBe("3");
      expect(jailArgv.some((a) => a.startsWith("--unshare"))).toBe(false);
      const dd = jailArgv.indexOf("--");
      expect(jailArgv.slice(dd, dd + 2)).toEqual(["--", "prlimit"]);
      expect(jailArgv.slice(-3)).toEqual(["/usr/bin/python3", "-m", "my_mcp_server"]);
      // The ONLY rw bind is the extension-data work dir (created on
      // demand under the project root).
      const workDir = join(JAIL_ROOT, ".ezcorp", "extension-data", "require-sandbox-probe");
      expect(existsSync(workDir)).toBe(true);
      const rwBinds: string[] = [];
      for (let i = 0; i < jailArgv.length; i++) {
        if (jailArgv[i] === "--bind") rwBinds.push(jailArgv[i + 1]!);
      }
      expect(rwBinds).toEqual([workDir]);

      expect(refusalRows()).toHaveLength(0);
      expect(
        auditCalls.find((c) => c.action === EXT_AUDIT_ACTIONS.MCP_NETNS_CREATED),
      ).toBeDefined();
      expect(
        auditCalls.find((c) => c.action === EXT_AUDIT_ACTIONS.MCP_VETH_CREATED),
      ).toBeDefined();

      await proxyHandle?.stop();
    } finally {
      spy.mockRestore();
      try {
        closeSync(fd);
      } catch {
        /* attached FDs stay open until the spawn caller closes them */
      }
    }
  });
});
