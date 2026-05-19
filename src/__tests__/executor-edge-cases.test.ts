import { test, expect, describe, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents, AgentRun } from "../types";

function makeAgent(
  name: string,
  fn: AgentDefinition["execute"],
): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    capabilities: ["shell"],
    execute: fn,
  };
}

// Mirror the watchdog/timer cleanup pattern from executor.test.ts. Without
// this, AgentExecutor's orphan-cleanup interval leaks across files and keeps
// the Bun worker alive past the test run.
const executors: AgentExecutor[] = [];
function track(exec: AgentExecutor): AgentExecutor {
  executors.push(exec);
  return exec;
}

afterAll(() => {
  for (const exec of executors) exec.destroy();
  executors.length = 0;
});

describe("AgentExecutor edge cases", () => {
  test("cancelRun aborts agent's signal mid-execution", async () => {
    let observedSignalAborted = false;
    const agents = loadAgentsStatic([
      makeAgent("waiter", async (ctx) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          ctx.signal.addEventListener("abort", () => {
            observedSignalAborted = true;
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
        return { success: true, output: null };
      }),
    ]);
    const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

    const runP = exec.runAgent("waiter", {});
    await new Promise((r) => setTimeout(r, 10));
    const [active] = await exec.listRuns();
    expect(exec.cancelRun(active!.id)).toBe(true);
    await runP;
    expect(observedSignalAborted).toBe(true);
    expect(active!.status).toBe("cancelled");
    // Well-behaved abort (agent threw on ctx.signal): cancelRun()'s
    // populated discriminator survives the error branch.
    const err = active!.result?.error as { code: string; message: string };
    expect(err?.code).toBe("cancelled");
  });

  test("agent failure surfaces error message in run.result", async () => {
    const agents = loadAgentsStatic([
      makeAgent("kaboom", async () => {
        throw new Error("explicit failure");
      }),
    ]);
    const events: { type: string; runId: string }[] = [];
    const bus = new EventBus<AgentEvents>();
    bus.on("run:error", (d) => events.push({ type: "error", runId: d.run.id }));
    const exec = track(new AgentExecutor(agents, bus));

    const run = await exec.runAgent("kaboom", {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toBe("explicit failure");
    expect(run.result?.success).toBe(false);
    expect(run.finishedAt).toBeDefined();
    expect(events).toEqual([{ type: "error", runId: run.id }]);
  });

  test("non-Error throw is coerced to string in run.result.error", async () => {
    const agents = loadAgentsStatic([
      makeAgent("throwString", async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string failure";
      }),
    ]);
    const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

    const run = await exec.runAgent("throwString", {});
    expect(run.status).toBe("error");
    expect(run.result?.error).toBe("raw string failure");
  });

  test("nested ctx.run() propagates child error to parent", async () => {
    const agents = loadAgentsStatic([
      makeAgent("parent", async (ctx) => {
        const childResult = await ctx.run("child", {});
        return { success: true, output: { childError: childResult.error } };
      }),
      makeAgent("child", async () => {
        throw new Error("child boom");
      }),
    ]);
    const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

    const run = await exec.runAgent("parent", {});
    expect(run.status).toBe("success");
    expect((run.result?.output as any).childError).toBe("child boom");
  });

  test("parallel runs emit events scoped to their own run id", async () => {
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const agents = loadAgentsStatic([
      makeAgent("a", async (ctx) => {
        ctx.log("a-log");
        await new Promise<void>((r) => (releaseA = r));
        return { success: true, output: "a" };
      }),
      makeAgent("b", async (ctx) => {
        ctx.log("b-log");
        await new Promise<void>((r) => (releaseB = r));
        return { success: true, output: "b" };
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    const logsByRun = new Map<string, string[]>();
    bus.on("run:log", ({ runId, log }) => {
      const arr = logsByRun.get(runId) ?? [];
      arr.push(log.message);
      logsByRun.set(runId, arr);
    });
    const exec = track(new AgentExecutor(agents, bus));

    const pA = exec.runAgent("a", {});
    const pB = exec.runAgent("b", {});
    await new Promise((r) => setTimeout(r, 10));
    releaseA();
    releaseB();
    const [runA, runB] = await Promise.all([pA, pB]);

    expect(runA.id).not.toBe(runB.id);
    expect(logsByRun.get(runA.id)).toEqual(["a-log"]);
    expect(logsByRun.get(runB.id)).toEqual(["b-log"]);
  });

  test("destroy() is idempotent (safe to call twice)", () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>());
    // intentionally not tracked: we verify the double-destroy ourselves.
    expect(() => {
      exec.destroy();
      exec.destroy();
    }).not.toThrow();
  });

  test("destroy() aborts in-flight runs", async () => {
    let signalAborted = false;
    const agents = loadAgentsStatic([
      makeAgent("forever", async (ctx) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 60_000);
          ctx.signal.addEventListener("abort", () => {
            signalAborted = true;
            clearTimeout(t);
            reject(new Error("destroyed"));
          });
        });
        return { success: true, output: null };
      }),
    ]);
    // not tracked — we destroy explicitly mid-test, the afterAll double-destroy
    // is exercised by another test and is safe.
    const exec = new AgentExecutor(agents, new EventBus<AgentEvents>());

    const runP = exec.runAgent("forever", {});
    await new Promise((r) => setTimeout(r, 10));
    exec.destroy();
    await runP;
    expect(signalAborted).toBe(true);
  });

  test("listRuns ordering is desc by startedAt across interleaved starts", async () => {
    const agents = loadAgentsStatic([
      makeAgent("quick", async () => ({ success: true, output: null })),
    ]);
    const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

    const runs: AgentRun[] = [];
    for (let i = 0; i < 5; i++) {
      runs.push(await exec.runAgent("quick", {}));
      await new Promise((r) => setTimeout(r, 2));
    }

    const listed = await exec.listRuns();
    expect(listed).toHaveLength(5);
    for (let i = 0; i < listed.length - 1; i++) {
      expect(listed[i]!.startedAt).toBeGreaterThanOrEqual(listed[i + 1]!.startedAt);
    }
    // Newest-first: last-started should be at index 0.
    expect(listed[0]!.id).toBe(runs[runs.length - 1]!.id);
  });

  test("cancelRun wins over a normal resolve in the agent's success branch", async () => {
    // Regression for the quirk surfaced in Wave 19: a "well-behaved"
    // cancellable agent throws on abort and the error branch's
    // !cancelled guard preserves the cancelled status. But an agent
    // that swallows the abort and resolves normally would otherwise
    // flip status back to "success" on the success branch. Both
    // branches must guard.
    const agents = loadAgentsStatic([
      makeAgent("swallows-abort", async (ctx) => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 60_000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(); // swallow — do NOT throw
          });
        });
        return { success: true, output: "should-not-stick" };
      }),
    ]);
    const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

    const runP = exec.runAgent("swallows-abort", {});
    await new Promise((r) => setTimeout(r, 10));
    const [active] = await exec.listRuns();
    expect(exec.cancelRun(active!.id)).toBe(true);
    await runP;
    // Status must remain "cancelled" — the success branch must respect
    // the prior cancelRun() write.
    expect(active!.status).toBe("cancelled");
    // Swallowed-abort discriminator: success branch overrides
    // cancelRun()'s "cancelled" code to flag the misbehaving path.
    const err = active!.result?.error as { code: string; message: string };
    expect(err?.code).toBe("swallowed_abort");
  });

  test("swallowed-abort path emits a warn log", async () => {
    // Capture stderr to assert the structured logger fires.
    // Pattern mirrors src/__tests__/logger.test.ts.
    const stderrChunks: string[] = [];
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const agents = loadAgentsStatic([
        makeAgent("swallows-and-logs", async (ctx) => {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 60_000);
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve(); // swallow — do NOT throw
            });
          });
          return { success: true, output: "ignored" };
        }),
      ]);
      const exec = track(new AgentExecutor(agents, new EventBus<AgentEvents>()));

      const runP = exec.runAgent("swallows-and-logs", {});
      await new Promise((r) => setTimeout(r, 10));
      const [active] = await exec.listRuns();
      expect(exec.cancelRun(active!.id)).toBe(true);
      await runP;

      const warnLines = stderrChunks
        .map((c) => {
          try { return JSON.parse(c) as { level?: string; msg?: string; subsystem?: string; agentName?: string }; }
          catch { return null; }
        })
        .filter((p): p is { level: string; msg: string; subsystem?: string; agentName?: string } =>
          p !== null && p.level === "warn" && p.msg === "agent resolved after cancel was requested",
        );
      expect(warnLines.length).toBe(1);
      expect(warnLines[0]!.subsystem).toBe("executor");
      expect(warnLines[0]!.agentName).toBe("swallows-and-logs");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });
});
