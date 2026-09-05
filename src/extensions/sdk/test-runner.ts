import { extensionV4Required } from "../loader";
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


export async function runExtensionTests(_opts?: TestRunnerOptions): Promise<number> {
  throw extensionV4Required();
}
