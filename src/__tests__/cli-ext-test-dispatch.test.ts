import { afterAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let runnerCalls: string[] = [];
let runnerExitCode = 0;

// Mock BEFORE importing ../cli.
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
  closeDb: async () => {},
}));
mock.module("../extensions/cli-control", () => ({
  initCliExtension: async () => "/source",
  stageCliExtension: async () => ({}),
  updateCliExtension: async () => ({}),
  removeCliExtension: async () => {},
  verifyCliExtension: async (directory: string) => {
    runnerCalls.push(directory);
    return { state: runnerExitCode === 0 ? "succeeded" : "failed", diagnostics: [] };
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
  test("runs the isolated release build and exits successfully", async () => {
    runnerCalls = [];
    runnerExitCode = 0;
    const code = await captureExit(() => cli(["ext", "test", "./my-ext"]));
    expect(code).toBe(0);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toBe("./my-ext");
  });

  test("a failing suite's exit code propagates verbatim", async () => {
    runnerCalls = [];
    runnerExitCode = 1;
    const code = await captureExit(() => cli(["ext", "test", "./my-ext"]));
    expect(code).toBe(1);
  });
});
