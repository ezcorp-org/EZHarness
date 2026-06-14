/**
 * Phase A4 — Seam A (extension subprocess) + Seam B (per-run agent shell)
 * OS-isolation wiring + END-TO-END containment.
 *
 * Seam A: ExtensionProcess.getSpawnArgs() wraps the prlimit/bun chain with
 *   buildSandboxArgv when EZCORP_PROJECT_ROOT is injected AND a usable tier
 *   is present. We assert the wrap shape + that the landlock spec never
 *   grants .ezcorp/data, then PROVE an extension-class process can't read it.
 *
 * Seam B: createShellTool(..., sandbox) jails `/bin/sh -c` to the per-run
 *   workspace. We assert resolveShellSandbox's argv/spec + PROVE a run's
 *   shell is denied .ezcorp/data but executes in its isolated workspace.
 *
 * The live containment spawns the SAME shim-wrapped argv each seam produces
 * in a CHILD (never jailing the runner). Skips where Landlock is unavailable.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionProcess } from "../extensions/subprocess";
import { resolveShellSandbox } from "../runtime/tools/shell";
import { buildSandboxArgv } from "../extensions/sandbox/build-sandbox-argv";
import { probeLandlockAbi } from "../extensions/sandbox/capability-probe";

const LANDLOCK_OK = (probeLandlockAbi() ?? 0) >= 1;

let ROOT: string;
let SECRET: string;

beforeAll(async () => {
  ROOT = realpathSync(await mkdtemp(join(tmpdir(), "a4-")));
  await mkdir(join(ROOT, ".ezcorp", "data"), { recursive: true });
  SECRET = join(ROOT, ".ezcorp", "data", "jwt-secret.txt");
  await writeFile(SECRET, "TOP-SECRET");
});
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("Seam A — ExtensionProcess.getSpawnArgs sandbox wrap", () => {
  test("no project root → unwrapped (back-compat)", () => {
    const ep = new ExtensionProcess("ext-nowrap", "/path/ext.ts", {});
    const args = ep.getSpawnArgs();
    expect(args[0]).toBe("prlimit");
    expect(args[2]).toBe("bun");
  });

  test("project root + usable tier → wrapped, inner prlimit chain preserved", () => {
    const ep = new ExtensionProcess("ext-wrap", "/path/ext.ts", {
      EZCORP_PROJECT_ROOT: ROOT,
      TMPDIR: join(ROOT, "tmp"),
    });
    const args = ep.getSpawnArgs();
    // Wrapped: first token is the isolation prefix (bun-shim on landlock,
    // bwrap on bwrap), NOT the bare prlimit chain.
    expect(args[0]).not.toBe("prlimit");
    expect(["bun", "bwrap"]).toContain(args[0]!);
    // The inner command is preserved somewhere in the argv.
    expect(args).toContain("prlimit");
    expect(args).toContain("/path/ext.ts");
    // Deny-by-default: re-derive the spec via the SAME builder the seam uses
    // and assert no granted path is under .ezcorp/data.
    const built = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: join(ROOT, ".ezcorp", "extension-data", "ext-wrap"),
      projectRoot: ROOT,
      command: "prlimit",
    });
    const spec = JSON.parse(built.env.EZCORP_LANDLOCK_SPEC!);
    for (const p of [...spec.ro, ...spec.rw]) {
      expect(p.startsWith(join(ROOT, ".ezcorp", "data"))).toBe(false);
    }
  });

  test("jail-build failure → fail-SAFE to unwrapped (catch branch)", async () => {
    // Point the project root at a FILE: mkdirSync of the extension-data
    // subdir throws ENOTDIR, the resolver catches it and returns null, and
    // getSpawnArgs falls back to the bare prlimit chain (never a hard fail).
    const fileRoot = join(ROOT, "not-a-dir");
    await writeFile(fileRoot, "x");
    const ep = new ExtensionProcess("ext-failsafe", "/path/ext.ts", {
      EZCORP_PROJECT_ROOT: fileRoot,
      TMPDIR: join(ROOT, "tmp"),
    });
    const args = ep.getSpawnArgs();
    expect(args[0]).toBe("prlimit"); // unwrapped fallback
  });

  test.if(LANDLOCK_OK)("extension-class jailed process is DENIED reading .ezcorp/data", () => {
    // The extension workspace is .ezcorp/extension-data/<id>; spawn a
    // shim-wrapped `cat <secret>` through the SAME builder the seam uses.
    const built = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: join(ROOT, ".ezcorp", "extension-data", "ext-deny"),
      projectRoot: ROOT,
      command: "cat",
      args: [SECRET],
    });
    const p = Bun.spawnSync(built.argv, {
      env: { ...process.env, ...built.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString().toLowerCase()).toContain("permission denied");
  });
});

describe("Seam B — createShellTool per-run workspace jail", () => {
  test("no sandbox wiring → null (back-compat, unjailed spawn)", () => {
    expect(resolveShellSandbox("echo hi", undefined)).toBeNull();
  });

  test("jail-build failure (workspace under .ezcorp/data) → null fail-safe", () => {
    // A workspace inside .ezcorp/data must be refused by the builder; the
    // resolver catches it and returns null (unjailed fallback, never throws).
    const evil = join(ROOT, ".ezcorp", "data", "ws");
    expect(resolveShellSandbox("echo hi", { workspaceDir: evil, projectRoot: ROOT })).toBeNull();
  });

  test("wired → jailed argv with workspace rw + no .ezcorp/data (tier-agnostic)", () => {
    const workspaceDir = join(ROOT, "run-123");
    const jail = resolveShellSandbox("echo hi", { workspaceDir, projectRoot: ROOT });
    expect(jail).not.toBeNull();
    // Either tier wraps the inner /bin/sh -c — assert the inner command
    // survives and (landlock leg) the spec excludes .ezcorp/data.
    expect(jail!.argv).toContain("/bin/sh");
    if (jail!.env.EZCORP_LANDLOCK_SPEC) {
      const spec = JSON.parse(jail!.env.EZCORP_LANDLOCK_SPEC);
      expect(spec.rw).toContain(workspaceDir);
      for (const p of [...spec.ro, ...spec.rw]) {
        expect(p.startsWith(join(ROOT, ".ezcorp", "data"))).toBe(false);
      }
    } else {
      // bwrap leg: the argv must never bind the host root or the data dir.
      for (let i = 0; i < jail!.argv.length; i++) {
        if (jail!.argv[i] === "--bind" || jail!.argv[i] === "--ro-bind") {
          expect(jail!.argv[i + 1]).not.toBe("/");
        }
      }
      expect(jail!.argv.some((a) => a === join(ROOT, ".ezcorp", "data"))).toBe(false);
    }
  });

  // Live containment for the per-run shell jail. We force the LANDLOCK tier
  // (the durable container path proven in A1/A3) via the same builder the
  // seam uses, because this dev host's bwrap is setuid root and its
  // unprivileged `--size`/`--tmpfs` flags are rejected (an environment
  // quirk, not a seam defect — the container resolves to landlock).
  test.if(LANDLOCK_OK)(
    "run shell (landlock) DENIED .ezcorp/data but EXECUTES in its isolated workspace",
    async () => {
      const workspaceDir = join(ROOT, "run-456");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "marker.txt"), "IN-WORKSPACE");

      const deny = buildSandboxArgv({
        tier: "landlock",
        workspaceDir,
        projectRoot: ROOT,
        command: "/bin/sh",
        args: ["-c", `cat ${SECRET}`],
      });
      const pDeny = Bun.spawnSync(deny.argv, {
        cwd: workspaceDir,
        env: { ...process.env, ...deny.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pDeny.exitCode).not.toBe(0);
      expect(pDeny.stderr.toString().toLowerCase()).toContain("permission denied");

      const allow = buildSandboxArgv({
        tier: "landlock",
        workspaceDir,
        projectRoot: ROOT,
        command: "/bin/sh",
        args: ["-c", "cat marker.txt"],
      });
      const pAllow = Bun.spawnSync(allow.argv, {
        cwd: workspaceDir,
        env: { ...process.env, ...allow.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pAllow.exitCode).toBe(0);
      expect(pAllow.stdout.toString()).toContain("IN-WORKSPACE");
    },
  );
});

describe("landlock tier — WRITE-inclusive jail (the production-tier fix)", () => {
  // The landlock-tier fs-jail must grant WRITE to the rw workspace (so git
  // switch/add/commit + file edits work — Seam B + open_pr) while denying
  // BOTH read and write of .ezcorp/data. Forces the landlock tier (the
  // container's production path; this dev host's bwrap is setuid-broken).
  test.if(LANDLOCK_OK)(
    "WRITE to the rw workspace SUCCEEDS; read AND write of .ezcorp/data DENIED",
    async () => {
      const workspaceDir = join(ROOT, "run-write");
      await mkdir(workspaceDir, { recursive: true });
      const dataDir = join(ROOT, ".ezcorp", "data");

      // (a) WRITE a new file in the workspace → must succeed.
      const newFile = join(workspaceDir, "agent-output.txt");
      const write = buildSandboxArgv({
        tier: "landlock",
        workspaceDir,
        projectRoot: ROOT,
        command: "/bin/sh",
        args: ["-c", `echo WROTE > ${newFile} && cat ${newFile}`],
      });
      const pWrite = Bun.spawnSync(write.argv, {
        cwd: workspaceDir,
        env: { ...process.env, ...write.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pWrite.exitCode).toBe(0);
      expect(pWrite.stdout.toString()).toContain("WROTE");

      // (b) READ of .ezcorp/data → denied (EACCES).
      const readDeny = buildSandboxArgv({
        tier: "landlock",
        workspaceDir,
        projectRoot: ROOT,
        command: "cat",
        args: [SECRET],
      });
      const pRead = Bun.spawnSync(readDeny.argv, {
        env: { ...process.env, ...readDeny.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pRead.exitCode).not.toBe(0);
      expect(pRead.stderr.toString().toLowerCase()).toContain("permission denied");

      // (c) WRITE under .ezcorp/data → denied (EACCES).
      const writeDeny = buildSandboxArgv({
        tier: "landlock",
        workspaceDir,
        projectRoot: ROOT,
        command: "/bin/sh",
        args: ["-c", `echo evil > ${join(dataDir, "evil.txt")}`],
      });
      const pWriteDeny = Bun.spawnSync(writeDeny.argv, {
        env: { ...process.env, ...writeDeny.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(pWriteDeny.exitCode).not.toBe(0);
      expect(pWriteDeny.stderr.toString().toLowerCase()).toContain("permission denied");
    },
  );
});
