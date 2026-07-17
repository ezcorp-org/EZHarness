/**
 * Covers the `ext:test` CLI dispatch (the `case "ext:test"` block in cli()):
 * the sdk test-runner is invoked with the parsed extDir/filter and its exit
 * code becomes the process exit code (`return process.exit(code)` — the
 * post-B2 shape with the dead break dropped). Runner + DB are mocked; the
 * exit is captured as a thrown sentinel (mirrors cli-workflow-list-dispatch).
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let runnerCalls: Array<{ extDir?: string; filter?: string }> = [];
let runnerExitCode = 0;

// Mock BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../extensions/sdk/test-runner", () => ({
  runExtensionTests: async (opts: { extDir?: string; filter?: string }) => {
    runnerCalls.push(opts);
    return runnerExitCode;
  },
}));

const { cli } = await import("../cli");

afterAll(() => restoreModuleMocks());

/** Run cli(...), capturing a process.exit(code) as a thrown sentinel. */
async function captureExit(fn: () => Promise<unknown>): Promise<number> {
  const orig = process.exit;
  let code: number | undefined;
  process.exit = ((c?: number): never => {
    code = c ?? 0;
    throw new Error(`__exit__:${code}`);
  }) as typeof process.exit;
  try {
    await fn();
    throw new Error("expected process.exit to be called");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit__:")) throw e;
  } finally {
    process.exit = orig;
  }
  return code!;
}

describe("cli ext:test dispatch", () => {
  test("runs the sdk test-runner and exits with its code (0)", async () => {
    runnerCalls = [];
    runnerExitCode = 0;
    const code = await captureExit(() => cli(["ext", "test", "./my-ext"]));
    expect(code).toBe(0);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.extDir).toBe("./my-ext");
  });

  test("a failing suite's exit code propagates verbatim", async () => {
    runnerCalls = [];
    runnerExitCode = 1;
    const code = await captureExit(() => cli(["ext", "test", "./my-ext"]));
    expect(code).toBe(1);
  });
});
