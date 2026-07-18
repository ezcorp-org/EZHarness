/**
 * Isolated coverage for the extension-spawn cwd pin (#61).
 *
 * Why a SEPARATE small file (not folded into subprocess.test.ts): that suite
 * OVERRIDES `ExtensionProcess.prototype.ensureRunning` (a Bun <=1.3.9 JIT
 * SIGILL workaround), so it can NOT attribute coverage to the REAL
 * `ensureRunning` — including the two lines this fix adds (`getSpawnCwd()` call
 * + the `...(cwd ? { cwd } : {})` spawn-option spread). Merging those lines'
 * coverage out of the big shard suites is exactly where Bun's per-line DA
 * attribution drifts on nested-async (see project memory). A small file that
 * drives the real `ensureRunning` with `Bun.spawn` SPIED (so no real child, no
 * SIGILL, no async) attributes those lines deterministically, and the coverage
 * merge SUMS per-line hits — so this can only add attribution, never weaken.
 *
 * Covers:
 *   - `getSpawnCwd()` both branches (project root present / absent / empty).
 *   - `ensureRunning()` pins the resolved cwd onto the `Bun.spawn` options when
 *     EZCORP_PROJECT_ROOT is injected, and omits `cwd` (inherit) when it isn't.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionProcess } from "../extensions/subprocess";

const echoPath = `${import.meta.dir}/helpers/echo-extension.ts`;
const baseEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

// Minimal stand-in for a Bun subprocess: `ensureRunning` wires a transport on
// stdin/stdout, drains stderr, and awaits `exited`. An already-closed stdout +
// null stderr make the transport + drain no-ops; a never-resolving `exited`
// keeps the crash/exit handler (which would hit the DB) from firing.
function fakeProc(): ReturnType<typeof Bun.spawn> {
  return {
    stdin: { write: () => 0, flush: () => {} },
    stdout: new Response("").body!,
    stderr: null,
    exited: new Promise<number>(() => {}),
    kill: () => {},
    pid: 4242,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("extension spawn cwd pin (#61)", () => {
  const tmpRoots: string[] = [];
  let ep: ExtensionProcess | null = null;

  afterEach(() => {
    ep?.kill();
    ep = null;
    for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // ── getSpawnCwd() — pure seam ───────────────────────────────────────
  test("getSpawnCwd pins EZCORP_PROJECT_ROOT when injected", () => {
    const root = "/tmp/ez-project-root-fixture";
    ep = new ExtensionProcess("cwd-ext", echoPath, { ...baseEnv, EZCORP_PROJECT_ROOT: root });
    expect(ep.getSpawnCwd()).toBe(root);
  });

  test("getSpawnCwd returns undefined when no project root is injected", () => {
    ep = new ExtensionProcess("cwd-ext", echoPath, baseEnv);
    expect(ep.getSpawnCwd()).toBeUndefined();
  });

  test("getSpawnCwd treats an empty EZCORP_PROJECT_ROOT as absent (inherit, not pin to '')", () => {
    ep = new ExtensionProcess("cwd-ext", echoPath, { ...baseEnv, EZCORP_PROJECT_ROOT: "" });
    expect(ep.getSpawnCwd()).toBeUndefined();
  });

  // ── ensureRunning() threads the pin onto the real Bun.spawn options ──
  test("ensureRunning pins cwd to the project root on the spawn options", () => {
    // Real dir so getSpawnArgs()'s sandbox-wrap mkdir (landlock tier) succeeds.
    const root = mkdtempSync(join(tmpdir(), "ez-cwd-pin-"));
    tmpRoots.push(root);
    let capturedCwd: string | undefined;
    let called = false;
    const spy = spyOn(Bun, "spawn").mockImplementation(((_argv: string[], opts?: { cwd?: string }) => {
      called = true;
      capturedCwd = opts?.cwd;
      return fakeProc();
    }) as unknown as typeof Bun.spawn);
    try {
      ep = new ExtensionProcess("cwd-ext", echoPath, { ...baseEnv, EZCORP_PROJECT_ROOT: root });
      ep.ensureRunning();
      expect(called).toBe(true);
      expect(capturedCwd).toBe(root);
    } finally {
      spy.mockRestore();
    }
  });

  // ── Sandbox-tier handoff for NESTED jail spawns (drive-3 push step) ──
  // The poisoned subprocess can't probe the tier or resolve the shim path
  // itself, so buildSpawnEnv must bake both into the child env — the ext's
  // jailed-git shell assembles `bun <shim> -- git …` purely from these.
  test("ensureRunning bakes EZCORP_SANDBOX_TIER + EZCORP_SANDBOX_SHIM into the child env", () => {
    const root = mkdtempSync(join(tmpdir(), "ez-tier-handoff-"));
    tmpRoots.push(root);
    let capturedEnv: Record<string, string> | undefined;
    const spy = spyOn(Bun, "spawn").mockImplementation(((_argv: string[], opts?: { env?: Record<string, string> }) => {
      capturedEnv = opts?.env;
      return fakeProc();
    }) as unknown as typeof Bun.spawn);
    try {
      ep = new ExtensionProcess("tier-ext", echoPath, { ...baseEnv, EZCORP_PROJECT_ROOT: root });
      ep.ensureRunning();
      expect(capturedEnv?.EZCORP_SANDBOX_TIER).toMatch(/^(bwrap|landlock|advisory)$/);
      expect(capturedEnv?.EZCORP_SANDBOX_SHIM).toMatch(/landlock-shim\.ts$/);
    } finally {
      spy.mockRestore();
    }
  });

  test("ensureRunning creates + grants the NAME-keyed extension-data dir (data-dir convention)", () => {
    const root = mkdtempSync(join(tmpdir(), "ez-name-grant-"));
    tmpRoots.push(root);
    const spy = spyOn(Bun, "spawn").mockImplementation((() => fakeProc()) as unknown as typeof Bun.spawn);
    try {
      ep = new ExtensionProcess(
        "name-ext-id",
        echoPath,
        { ...baseEnv, EZCORP_PROJECT_ROOT: root },
        { extensionName: "my-named-ext" },
      );
      ep.ensureRunning();
      // The convention home extensions actually write (keyed by manifest
      // NAME, not install id) exists — created so its landlock grant binds
      // a real inode. On an advisory host resolveSandboxWrap returns null
      // before the mkdir, so only assert under a usable tier.
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      const { getSandboxTier } = require("../extensions/sandbox/capability-probe") as typeof import("../extensions/sandbox/capability-probe");
      if (getSandboxTier() !== "advisory") {
        expect(existsSync(join(root, ".ezcorp", "extension-data", "my-named-ext"))).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("ensureRunning omits cwd (inherit) when no project root is injected", () => {
    let capturedCwd: string | undefined = "SENTINEL";
    let called = false;
    const spy = spyOn(Bun, "spawn").mockImplementation(((_argv: string[], opts?: { cwd?: string }) => {
      called = true;
      capturedCwd = opts?.cwd;
      return fakeProc();
    }) as unknown as typeof Bun.spawn);
    try {
      ep = new ExtensionProcess("cwd-ext", echoPath, baseEnv);
      ep.ensureRunning();
      expect(called).toBe(true);
      expect(capturedCwd).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
