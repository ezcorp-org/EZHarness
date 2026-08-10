/**
 * CRITICAL fs-confinement fix — mcp-launcher.sh branch coverage.
 *
 * bwrap/netns cannot run on this host (and must not run in unit tests),
 * so the launcher is exercised with a PATH-stubbed `bwrap` that prints
 * the argv it would have exec'd. This locks the shell-side contract at
 * the ARG level:
 *
 *   1. EZCORP_MCP_FS_JAIL=1 → `exec bwrap "$@"` verbatim (the host-built
 *      minimal-bind argv is NOT re-derived or reordered by the shell).
 *   2. Default bwrap branch + EZCORP_MCP_DATA_DIR → the data-dir tmpfs
 *      mask is mounted AFTER the root bind and BEFORE the /tmp tmpfs,
 *      with its own 1 MiB --size; seccomp FD ordering is preserved.
 *   3. Default bwrap branch without EZCORP_MCP_DATA_DIR → byte-identical
 *      legacy argv (zero behavior change for existing deployments).
 *   4. EZCORP_MCP_REQUIRE_SANDBOX=1 reaching the raw-exec fallback →
 *      exit 94, the MCP command is NEVER exec'd (fail-closed belt &
 *      suspenders under the host-side static gate).
 *   5. No flags → raw-exec fallback still runs the command (existing
 *      fail-open default posture preserved).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "extensions", "mcp-launcher.sh");

let stubBin: string;

beforeAll(() => {
  stubBin = mkdtempSync(join(tmpdir(), "ez-launcher-stub-"));
  // Stub bwrap: one argv element per line, between markers.
  writeFileSync(
    join(stubBin, "bwrap"),
    '#!/bin/sh\necho BWRAP_ARGV_BEGIN\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\necho BWRAP_ARGV_END\n',
  );
  chmodSync(join(stubBin, "bwrap"), 0o755);
  // Stub capsh whose probe always fails → the launcher's fallback leg
  // deterministically reaches the raw `exec "$@"`.
  writeFileSync(join(stubBin, "capsh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubBin, "capsh"), 0o755);
});

afterAll(() => {
  rmSync(stubBin, { recursive: true, force: true });
});

async function runLauncher(
  env: Record<string, string>,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; argv: string[] }> {
  const proc = Bun.spawn({
    cmd: ["sh", LAUNCHER, ...args],
    env: { PATH: `${stubBin}:${process.env.PATH ?? ""}`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = stdout.split("\n");
  const begin = lines.indexOf("BWRAP_ARGV_BEGIN");
  const end = lines.indexOf("BWRAP_ARGV_END");
  const argv = begin >= 0 && end > begin ? lines.slice(begin + 1, end) : [];
  return { exitCode, stdout, stderr, argv };
}

const skip = process.platform === "win32";

describe.skipIf(skip)("mcp-launcher.sh — EZCORP_MCP_FS_JAIL strict branch", () => {
  test("execs bwrap with the host-built argv VERBATIM", async () => {
    const jailArgv = [
      "--die-with-parent",
      "--ro-bind",
      "/usr",
      "/usr",
      "--bind",
      "/work",
      "/work",
      "--tmpfs",
      "/tmp",
      "--seccomp",
      "3",
      "--",
      "prlimit",
      "--rss=1",
      "echo",
      "hi",
    ];
    const r = await runLauncher({ EZCORP_MCP_FS_JAIL: "1" }, jailArgv);
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual(jailArgv);
  });
});

describe.skipIf(skip)("mcp-launcher.sh — default bwrap branch", () => {
  test("EZCORP_MCP_DATA_DIR set + seccomp → mask AFTER root bind, BEFORE /tmp tmpfs, own 1MiB size", async () => {
    const r = await runLauncher(
      {
        EZCORP_MCP_BWRAP_ENABLED: "1",
        EZCORP_MCP_DATA_DIR: "/srv/proj/.ezcorp/data",
        EZCORP_MCP_BWRAP_SECCOMP_FD: "3",
      },
      ["mycmd", "a1"],
    );
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual([
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      "/",
      "/",
      "--size",
      "1048576",
      "--tmpfs",
      "/srv/proj/.ezcorp/data",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      "--seccomp",
      "3",
      "--",
      "mycmd",
      "a1",
    ]);
  });

  test("colon-separated EZCORP_MCP_DATA_DIR → each dir masked with its own 1MiB tmpfs, after root bind", async () => {
    const r = await runLauncher(
      {
        EZCORP_MCP_BWRAP_ENABLED: "1",
        // Real DB data dir + the `.ezcorp/data` convention path.
        EZCORP_MCP_DATA_DIR: "/app/data:/srv/proj/.ezcorp/data",
      },
      ["mycmd"],
    );
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual([
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      "/",
      "/",
      // Masks are prepended in loop order, so the last-listed dir ends up
      // first; both are mounted AFTER the root bind so they shadow it.
      "--size",
      "1048576",
      "--tmpfs",
      "/srv/proj/.ezcorp/data",
      "--size",
      "1048576",
      "--tmpfs",
      "/app/data",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      "--",
      "mycmd",
    ]);
    // Every masked dir lands on a tmpfs after the root bind — no host
    // path under either dir is reachable.
    const bindIdx = r.argv.indexOf("--bind");
    expect(r.argv.lastIndexOf("--tmpfs")).toBeGreaterThan(bindIdx);
    expect(r.argv).toContain("/app/data");
    expect(r.argv).toContain("/srv/proj/.ezcorp/data");
  });

  test("no EZCORP_MCP_DATA_DIR → legacy argv preserved byte-for-byte (no seccomp)", async () => {
    const r = await runLauncher({ EZCORP_MCP_BWRAP_ENABLED: "1" }, ["mycmd", "a1"]);
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual([
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      "/",
      "/",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      "--",
      "mycmd",
      "a1",
    ]);
  });

  test("no EZCORP_MCP_DATA_DIR → legacy argv preserved byte-for-byte (with seccomp)", async () => {
    const r = await runLauncher(
      { EZCORP_MCP_BWRAP_ENABLED: "1", EZCORP_MCP_BWRAP_SECCOMP_FD: "3" },
      ["mycmd", "a1"],
    );
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual([
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--bind",
      "/",
      "/",
      "--size",
      "67108864",
      "--tmpfs",
      "/tmp",
      "--seccomp",
      "3",
      "--",
      "mycmd",
      "a1",
    ]);
  });
});

describe.skipIf(skip)("mcp-launcher.sh — raw-exec fallback", () => {
  test("EZCORP_MCP_REQUIRE_SANDBOX=1 without a bwrap branch → exit 94, command never runs", async () => {
    const r = await runLauncher({ EZCORP_MCP_REQUIRE_SANDBOX: "1" }, [
      "sh",
      "-c",
      "echo SHOULD_NOT_RUN",
    ]);
    expect(r.exitCode).toBe(94);
    expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(r.stderr).toContain("refusing raw exec");
  });

  test("no flags → existing fail-open raw exec still runs the command", async () => {
    const r = await runLauncher({}, ["sh", "-c", "echo RAW_OK"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RAW_OK");
  });
});
