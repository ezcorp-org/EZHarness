/**
 * Phase A2 — landlock-tier END-TO-END containment (integration).
 *
 * Spawns the real `buildSandboxArgv({ tier: "landlock" })` argv (the
 * `bun landlock-shim.ts` wrapper) in a CHILD process — never the test runner
 * itself, since restrict_self would irreversibly jail it. Proves:
 *   - a child reading a file under `.ezcorp/data` is DENIED (non-zero exit,
 *     EACCES), and
 *   - a child reading its allowed workspace SUCCEEDS.
 *
 * This is the same proof A1's self-test gave, now flowing through the A2
 * builder + shim seam (covers runShim + applyLandlockJailSpec live).
 *
 * Skips cleanly where Landlock is unavailable (non-Linux / old kernel /
 * advisory tier) so CI on such hosts is green rather than red.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxArgv } from "../extensions/sandbox/build-sandbox-argv";
import { probeLandlockAbi } from "../extensions/sandbox/capability-probe";

const LANDLOCK_OK = (probeLandlockAbi() ?? 0) >= 1;

let ROOT: string;
let WS: string;
let SECRET: string;

beforeAll(async () => {
  ROOT = realpathSync(await mkdtemp(join(tmpdir(), "a2int-")));
  WS = join(ROOT, "workspace");
  await mkdir(WS, { recursive: true });
  await mkdir(join(ROOT, ".ezcorp", "data"), { recursive: true });
  await writeFile(join(WS, "ok.txt"), "ALLOWED-WORKSPACE");
  SECRET = join(ROOT, ".ezcorp", "data", "jwt-secret.txt");
  await writeFile(SECRET, "TOP-SECRET");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe.if(LANDLOCK_OK)("landlock tier — child containment via the shim", () => {
  test("DENIES reading a file under .ezcorp/data", () => {
    const built = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: WS,
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

  test("ALLOWS reading the workspace file", () => {
    const built = buildSandboxArgv({
      tier: "landlock",
      workspaceDir: WS,
      projectRoot: ROOT,
      command: "cat",
      args: [join(WS, "ok.txt")],
    });
    const p = Bun.spawnSync(built.argv, {
      env: { ...process.env, ...built.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("ALLOWED-WORKSPACE");
  });
});

// Always-present guard so the file has at least one active test even where
// Landlock is unavailable (keeps the suite meaningful on every host).
test("buildSandboxArgv landlock argv is shaped for the shim", () => {
  const built = buildSandboxArgv({
    tier: "landlock",
    workspaceDir: WS,
    projectRoot: ROOT,
    command: "cat",
    args: ["x"],
  });
  expect(built.argv[0]).toBe("bun");
  expect(built.argv[1]).toMatch(/landlock-shim\.ts$/);
});
