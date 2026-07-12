/**
 * Issue #60 regression — bundled extension subprocess bring-up under the
 * landlock jail.
 *
 * The `resolveSandboxWrap()` grant set gives an extension file-READ to its OWN
 * dir, the preload dir, and `node_modules`/`packages` (RO), plus the project
 * root TRAVERSE-only (READ_DIR, never READ_FILE). A bundled extension that
 * imported a runtime VALUE from `src/**` (Bun can't elide the import) therefore
 * died at module-load with `EACCES reading ".../src/..."` → exit 1 → the
 * JSON-RPC transport never came up. Two bundled extensions hit this:
 * `github-projects` (`src/integrations/github-projects/types`) and
 * `task-tracking` (`src/runtime/task-dependencies`). Both now own the shared
 * contract INSIDE their own (jail-readable) dir.
 *
 * This spec spawns each REAL entrypoint through the REAL ExtensionProcess
 * sandbox wrap (`getSpawnArgs()` + `buildSpawnEnv()` → the same
 * `resolveSandboxWrap`/`buildSandboxArgv` chain production uses) and asserts
 * module-load SUCCEEDS: the argv is shim-wrapped, there is no `EACCES reading`
 * in stderr, and the child exits cleanly (0) when stdin closes — where before
 * the fix it exited 1 at bring-up. A negative control proves the jail still
 * DENIES reading `.ezcorp/data`, so the fix widened no grant.
 *
 * Gated on Landlock like the Seam-A/B live tests (sandbox-seam-a-b.test.ts):
 * advisory hosts run unjailed (no jail to regress). The production container +
 * GitHub hosted runners have Landlock, so this gates the real path.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExtensionProcess } from "../extensions/subprocess";
import { buildSandboxArgv } from "../extensions/sandbox/build-sandbox-argv";
import { probeLandlockAbi } from "../extensions/sandbox/capability-probe";

const LANDLOCK_OK = (probeLandlockAbi() ?? 0) >= 1;
const REPO_ROOT = realpathSync(resolve(import.meta.dir, "..", ".."));

// Bundled extensions that historically imported a runtime VALUE from `src/**`
// (the #60 crash). Each entrypoint must load under the jail now that the
// shared contract lives inside the extension's own dir.
const JAILED_ENTRYPOINTS: ReadonlyArray<{ name: string; entry: string }> = [
  { name: "github-projects", entry: "docs/extensions/examples/github-projects/index.ts" },
  { name: "task-tracking", entry: "docs/extensions/examples/task-tracking/index.ts" },
  // graded-card-scanner imports third-party npm deps (@zxing/library,
  // fast-png, jpeg-js) at module load via lib/decode — proving they load
  // under the jail (read from the RO-granted node_modules) is the
  // regression guard for the missing-dep crash-loop (2026-07-11).
  { name: "graded-card-scanner", entry: "docs/extensions/examples/graded-card-scanner/index.ts" },
];

const TMP_BASE = join(REPO_ROOT, ".ezcorp", "tmp-jail-bringup");

beforeAll(async () => {
  // The host always injects a TMPDIR (granted rw in the wrap); create one per
  // extension so the jail grant resolves to a real dir.
  for (const { name } of JAILED_ENTRYPOINTS) {
    await mkdir(join(TMP_BASE, name), { recursive: true });
  }
});
afterAll(async () => {
  await rm(TMP_BASE, { recursive: true, force: true });
});

/**
 * Spawn a real extension entrypoint through the real ExtensionProcess wrap and
 * observe its bring-up. Returns whether the argv was shim-wrapped, the exit
 * code (stdin is closed so a cleanly-loaded SDK subprocess exits 0 on EOF), and
 * the stderr tail (which carries a module-load `EACCES` if the jail denies it).
 */
async function spawnJailedBringup(
  name: string,
  entry: string,
): Promise<{ wrapped: boolean; exitCode: number; stderr: string }> {
  const ep = new ExtensionProcess(name, join(REPO_ROOT, entry), {
    EZCORP_PROJECT_ROOT: REPO_ROOT,
    TMPDIR: join(TMP_BASE, name),
  });
  const argv = ep.getSpawnArgs();
  // On a landlock host the argv MUST be shim-wrapped (the isolation prefix,
  // not the bare `prlimit` chain) — otherwise we'd be asserting an unjailed
  // spawn and the regression would be untested.
  const wrapped = argv[0] !== "prlimit";
  const env = (
    ep as unknown as { buildSpawnEnv(): Record<string, string> }
  ).buildSpawnEnv();
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Close stdin so the SDK's stdin read-loop hits EOF and the process exits
  // cleanly ONCE module-load has completed. A load-time EACCES exits 1 first.
  proc.stdin.end();
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(`${name}: subprocess bring-up timed out`));
      }, 15_000),
    ),
  ]);
  const stderr = await new Response(proc.stderr).text();
  return { wrapped, exitCode, stderr };
}

describe("issue #60 — bundled extension subprocess loads under the landlock jail", () => {
  for (const { name, entry } of JAILED_ENTRYPOINTS) {
    test.if(LANDLOCK_OK)(
      `${name} entrypoint loads (no module-load EACCES on src/**)`,
      async () => {
        const { wrapped, exitCode, stderr } = await spawnJailedBringup(name, entry);
        // The wrap is active (this is a real jailed spawn, not a fallback).
        expect(wrapped).toBe(true);
        // The #60 signature — `EACCES reading ".../src/..."` at module-load.
        expect(stderr).not.toMatch(/EACCES reading/i);
        // A clean bring-up: stdin EOF → exit 0 (a load crash exits 1).
        expect(exitCode).toBe(0);
      },
      20_000,
    );
  }

  test.if(LANDLOCK_OK)(
    "containment intact — a jailed read of .ezcorp/data is still DENIED",
    async () => {
      const root = realpathSync(await mkdtemp(join(tmpdir(), "gh60-")));
      try {
        await mkdir(join(root, ".ezcorp", "data"), { recursive: true });
        const secret = join(root, ".ezcorp", "data", "jwt-secret.txt");
        await writeFile(secret, "TOP-SECRET");
        // Same builder the extension wrap uses; the workspace is the ext-data
        // sibling of .ezcorp/data, which must never be read-granted.
        const built = buildSandboxArgv({
          tier: "landlock",
          workspaceDir: join(root, ".ezcorp", "extension-data", "gh60"),
          projectRoot: root,
          command: "cat",
          args: [secret],
        });
        const p = Bun.spawnSync(built.argv, {
          env: { ...process.env, ...built.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(p.exitCode).not.toBe(0);
        expect(p.stderr.toString().toLowerCase()).toContain("permission denied");
        expect(p.stdout.toString()).not.toContain("TOP-SECRET");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
