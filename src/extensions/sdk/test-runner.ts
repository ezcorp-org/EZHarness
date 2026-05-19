/**
 * Extension test runner -- runs bun test with sandbox constraints.
 * Wraps `bun test` with prlimit memory limits and filtered environment.
 */

import { loadManifest } from "../loader";
import { DEFAULT_MEMORY_LIMIT_MB, parseMemoryLimit } from "../subprocess";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface TestRunnerOptions {
  extDir?: string;
  filter?: string;
  timeout?: number; // per-test timeout in ms (default 30000)
  memoryLimit?: string; // e.g. "256MB" (default from manifest or 512MB)
}

/**
 * Build the spawn args for running tests with prlimit + bun test.
 */
export function buildTestSpawnArgs(opts?: Pick<TestRunnerOptions, "filter" | "timeout" | "memoryLimit">): string[] {
  const memStr = opts?.memoryLimit ?? `${DEFAULT_MEMORY_LIMIT_MB}MB`;
  const memBytes = parseMemoryLimit(memStr);

  const args = ["prlimit", `--rss=${memBytes}`, "bun", "test"];

  if (opts?.filter) {
    args.push("--filter", opts.filter);
  }

  if (opts?.timeout) {
    args.push("--timeout", String(opts.timeout));
  }

  return args;
}

/**
 * Build sandboxed environment for test execution.
 * Only includes PATH, HOME, TMPDIR, NODE_ENV, and BUN_ENV.
 */
export function buildTestEnv(extId?: string): Record<string, string> {
  const testTmpDir = join(tmpdir(), "ezcorp-ext-test", extId ?? "default");
  mkdirSync(testTmpDir, { recursive: true });

  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
    BUN_ENV: "test",
    TMPDIR: testTmpDir,
  };
}

/**
 * Run extension tests in a sandboxed environment.
 * Returns the exit code from the bun test process.
 */
export async function runExtensionTests(opts?: TestRunnerOptions): Promise<number> {
  const extDir = opts?.extDir ?? process.cwd();

  // Read and validate manifest
  const manifestData = await loadManifest(extDir);
  const manifest = manifestData as { name: string; resources?: { memory?: string } };

  // Build spawn args with manifest resource limits
  const spawnArgs = buildTestSpawnArgs({
    filter: opts?.filter,
    timeout: opts?.timeout ?? 30000,
    memoryLimit: manifest.resources?.memory,
  });

  // Build sandboxed env
  const env = buildTestEnv(manifest.name);

  // Spawn bun test with sandbox constraints
  const proc = Bun.spawn(spawnArgs, {
    cwd: extDir,
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });

  const code = await proc.exited;
  if (code !== 0) return code;

  // Fold-in: if the manifest declares a deterministic smokeTest, run
  // the same sandboxed round-trip `ezcorp ext verify` uses and
  // propagate a non-zero exit on failure. `bun test` passing alone is
  // NOT acceptance — the loop incident showed unit tests can be green
  // while the extension fails to load or round-trip in the sandbox.
  if ((manifest as { smokeTest?: unknown }).smokeTest) {
    const { verifyExtension } = await import("./verify");
    const result = await verifyExtension({ extDir });
    for (const step of result.steps) {
      // eslint-disable-next-line no-console
      console.log(`${step.ok ? "✓" : "✗"} smoke:${step.name}: ${step.detail}`);
    }
    if (!result.pass) return 1;
  }

  return 0;
}
