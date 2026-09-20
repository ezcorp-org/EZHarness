import { describe, expect, test } from "bun:test";
import { raceControlled } from "../runtime/tools/race-control";

describe("raceControlled", () => {
  test("returns completed work and removes its abort listener", async () => {
    const controller = new AbortController();
    let additions = 0;
    let removals = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<typeof add>) => { additions++; return add(...args); };
    controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removals++; return remove(...args); };

    expect(await raceControlled(Promise.resolve(7), 40_000, controller.signal)).toEqual({ type: "done", value: 7 });
    expect({ additions, removals }).toEqual({ additions: 1, removals: 1 });
  });

  test("cleans up when work rejects", async () => {
    const controller = new AbortController();
    let removals = 0;
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => { removals++; return remove(...args); };
    await expect(raceControlled(Promise.reject(new Error("failed")), 40_000, controller.signal)).rejects.toThrow("failed");
    expect(removals).toBe(1);
  });

  test.each([
    ["shell", `const { createShellTool } = await import("./src/runtime/tools/shell.ts");\nconst result = await createShellTool(process.cwd()).execute("probe", { command: "printf immediate", timeout: 40000 });\nif (result.content[0]?.text !== "immediate") throw new Error("unexpected shell output");`],
    ["grep", `process.env.EZCORP_GREP_TIMEOUT_MS = "40000";\nconst { createGrepTool } = await import("./src/runtime/tools/grep.ts");\nconst result = await createGrepTool(process.cwd()).execute("probe", { pattern: "raceControlled", path: "src/runtime/tools/race-control.ts" });\nif (!result.content[0]?.text.includes("raceControlled")) throw new Error("unexpected grep output");`],
  ])("lets a successful %s subprocess exit before its long deadline", async (_name, source) => {
    const child = Bun.spawn([process.execPath, "-e", source], {
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const exitCode = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => { guard = setTimeout(() => resolve(null), 5_000); }),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });

  test("reports timeout", async () => {
    expect(await raceControlled(new Promise(() => {}), 1)).toEqual({ type: "timeout" });
  });

  test("reports a later abort", async () => {
    const controller = new AbortController();
    const outcome = raceControlled(new Promise(() => {}), 40_000, controller.signal);
    controller.abort();
    expect(await outcome).toEqual({ type: "aborted" });
  });

  test("reports an abort that already happened", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await raceControlled(new Promise(() => {}), 40_000, controller.signal)).toEqual({ type: "aborted" });
  });
});
