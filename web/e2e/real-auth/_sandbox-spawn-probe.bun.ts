/**
 * Sandbox-spawn capability probe — the BUN half.
 *
 * This script is NEVER imported by the Playwright specs (they run under
 * Node, where `bun:ffi` — reachable via the sandbox capability probe →
 * landlock-ffi — cannot load). Instead `sandbox-probe.ts` shells out to
 * `bun run <this file>` and reads the EXIT CODE:
 *
 *   exit 0 → this host CAN spawn a sandboxed extension subprocess.
 *   exit 1 → it CANNOT (skip the extension-spawn specs).
 *
 * WHY A REAL SPAWN (not a proxy signal): every extension subprocess is
 * launched by `src/extensions/subprocess.ts` (getSpawnArgs) as the exact
 * inner chain `prlimit --rss=<bytes> bun run …`, wrapped for the resolved
 * sandbox tier by the SAME `buildSandboxArgv` seam we call here. On GitHub
 * hosted runners the tier resolves to `landlock` and the jail engages
 * correctly, but the runner's `bun` (installed by setup-bun under
 * `~/.bun/bin`) is OUTSIDE the sandbox read-exec allowlist
 * (`DEFAULT_RUNTIME_RO_DIRS`), so the jailed `prlimit … bun` exec is denied
 * — `prlimit: failed to execute bun: Permission denied` (EACCES → exit 126)
 * — and every extension dies at bring-up. On a NixOS/dev host or the prod
 * container `bun` resolves under a granted dir (`/nix`, `/usr`), so the same
 * jailed exec succeeds.
 *
 * Because this probe runs that identical machinery — the real tier probe,
 * the real `buildSandboxArgv`, the real landlock shim + spec — around the
 * real `prlimit + bun` chain, its verdict CANNOT drift from what the server
 * actually does when it spawns an extension. It is the primitive, not a
 * heuristic (no "is this CI?" / userns / arch guessing).
 *
 * Relative (not `$server`) imports on purpose: `$server` is a SvelteKit
 * build-time alias that a bare `bun run` does not resolve.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxArgv } from "../../../src/extensions/sandbox/build-sandbox-argv";
import { getSandboxTier } from "../../../src/extensions/sandbox/capability-probe";
import { DEFAULT_RUNTIME_RO_DIRS } from "../../../src/extensions/sandbox/landlock";

// Mirror MIN_MEMORY_LIMIT_MB in src/extensions/subprocess.ts (512 MB). The
// exact value is immaterial to the probe — any valid RLIMIT_RSS exercises
// prlimit's execvp of the child (`bun`), which is the step that is denied
// on a capless runner.
const MEM_BYTES = 512 * 1024 * 1024;

// The exact inner chain the extension sandbox execs (subprocess.ts) minus the
// preload + entrypoint: `prlimit --rss=<bytes> bun --version`. `bun --version`
// is a side-effect-free invocation that still forces prlimit's exec of bun —
// the operation that fails under a jail that doesn't grant bun's directory.
const INNER = ["prlimit", `--rss=${MEM_BYTES}`, "bun", "--version"] as const;

function spawnUnjailed(): boolean {
  try {
    return Bun.spawnSync([...INNER], { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
}

function canSpawnSandboxed(): boolean {
  const projectRoot = process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  try {
    const tier = getSandboxTier();
    // Advisory tier applies NO OS isolation (subprocess.ts runs the inner
    // chain as-is), so bun's exec is never jail-gated — a plain spawn is the
    // faithful check.
    if (tier === "advisory") return spawnUnjailed();

    // Jailed tier (landlock/bwrap): reproduce subprocess.ts resolveSandboxWrap()'s
    // grant set — the conventional runtime RO dirs plus the workspace deps —
    // and run the inner chain THROUGH the real jail. If bun's real directory
    // isn't reachable in that grant set the jailed exec is denied, exactly as
    // on the hosted runner.
    const workspaceDir = mkdtempSync(join(tmpdir(), "ezcorp-spawn-probe-"));
    const roPaths = [...DEFAULT_RUNTIME_RO_DIRS];
    for (const dep of [join(projectRoot, "node_modules"), join(projectRoot, "packages")]) {
      if (existsSync(dep)) roPaths.push(dep);
    }
    const built = buildSandboxArgv({
      tier,
      workspaceDir,
      projectRoot,
      roPaths,
      rwPaths: [workspaceDir],
      traversePaths: [projectRoot],
      command: INNER[0],
      args: INNER.slice(1),
    });
    return Bun.spawnSync(built.argv, {
      env: { ...process.env, ...built.env },
      stdout: "ignore",
      stderr: "ignore",
    }).success;
  } catch {
    // Fail-SAFE mirror of subprocess.ts: a jail-build error there falls back
    // to an unjailed spawn, so the faithful verdict is the unjailed result.
    return spawnUnjailed();
  }
}

process.exit(canSpawnSandboxed() ? 0 : 1);
