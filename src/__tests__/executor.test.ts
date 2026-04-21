import { test, expect, describe } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentDefinition, AgentEvents } from "../types";

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

describe("AgentExecutor", () => {
  test("successful run returns status success with result", async () => {
    const agents = loadAgentsStatic([
      makeAgent("echo", async (ctx) => ({
        success: true,
        output: ctx.input.msg,
      })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("echo", { msg: "hello" });

    expect(run.status).toBe("success");
    expect(run.result?.success).toBe(true);
    expect(run.result?.output).toBe("hello");
    expect(run.finishedAt).toBeDefined();
    expect(run.id).toBeTruthy();
  });

  test("error run returns status error with message", async () => {
    const agents = loadAgentsStatic([
      makeAgent("fail", async () => {
        throw new Error("boom");
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("fail", {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toBe("boom");
  });

  test("throws if agent not found", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    expect(exec.runAgent("nope", {})).rejects.toThrow("Agent not found: nope");
  });

  test("emits run:start, run:log, run:complete events", async () => {
    const events: string[] = [];
    const agents = loadAgentsStatic([
      makeAgent("logger", async (ctx) => {
        ctx.log("step 1");
        return { success: true, output: null };
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    bus.on("run:start", () => events.push("start"));
    bus.on("run:log", () => events.push("log"));
    bus.on("run:complete", () => events.push("complete"));

    const exec = new AgentExecutor(agents, bus);
    await exec.runAgent("logger", {});

    expect(events).toEqual(["start", "log", "complete"]);
  });

  test("listAgents returns loaded agents", () => {
    const agents = loadAgentsStatic([
      makeAgent("a", async () => ({ success: true, output: null })),
      makeAgent("b", async () => ({ success: true, output: null })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    expect(exec.listAgents()).toHaveLength(2);
  });

  test("listRuns returns runs sorted by startedAt desc", async () => {
    const agents = loadAgentsStatic([
      makeAgent("x", async () => ({ success: true, output: null })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    await exec.runAgent("x", {});
    await exec.runAgent("x", {});

    const runs = await exec.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.startedAt).toBeGreaterThanOrEqual(runs[1]!.startedAt);
  });

  test("getRun returns run by id", async () => {
    const agents = loadAgentsStatic([
      makeAgent("x", async () => ({ success: true, output: null })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("x", {});
    expect(await exec.getRun(run.id)).toBe(run);
    expect(await exec.getRun("nonexistent")).toBeUndefined();
  });

  test("cancelRun sets status to cancelled", async () => {
    const agents = loadAgentsStatic([
      makeAgent("slow", async (ctx) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return { success: true, output: null };
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    const cancelEvents: unknown[] = [];
    bus.on("run:cancel", (data) => cancelEvents.push(data));

    const exec = new AgentExecutor(agents, bus);

    const runPromise = exec.runAgent("slow", {});
    await new Promise((r) => setTimeout(r, 10));

    const runs = await exec.listRuns();
    expect(runs).toHaveLength(1);
    const cancelled = exec.cancelRun(runs[0]!.id);
    expect(cancelled).toBe(true);
    expect(runs[0]!.status).toBe("cancelled");
    expect(cancelEvents).toHaveLength(1);

    await runPromise;
  });

  test("max 100 runs limit trims oldest", async () => {
    const agents = loadAgentsStatic([
      makeAgent("x", async () => ({ success: true, output: null })),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const firstRun = await exec.runAgent("x", {});

    for (let i = 0; i < 100; i++) {
      await exec.runAgent("x", {});
    }

    expect((await exec.listRuns())).toHaveLength(100);
    expect(await exec.getRun(firstRun.id)).toBeUndefined();
  });

  test("registerAgent and unregisterAgent", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus);

    expect(exec.listAgents()).toHaveLength(0);

    exec.registerAgent(makeAgent("dynamic", async () => ({ success: true, output: "dynamic" })));
    expect(exec.listAgents()).toHaveLength(1);

    const run = await exec.runAgent("dynamic", {});
    expect(run.result?.output).toBe("dynamic");

    const removed = exec.unregisterAgent("dynamic");
    expect(removed).toBe(true);
    expect(exec.listAgents()).toHaveLength(0);

    expect(exec.unregisterAgent("nonexistent")).toBe(false);
  });

  test("ctx.run() allows nested agent invocation", async () => {
    const agents = loadAgentsStatic([
      makeAgent("parent", async (ctx) => {
        const childResult = await ctx.run("child", { value: 42 });
        return { success: true, output: { childOutput: childResult.output } };
      }),
      makeAgent("child", async (ctx) => {
        return { success: true, output: `received: ${ctx.input.value}` };
      }),
    ]);
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(agents, bus);

    const run = await exec.runAgent("parent", {});

    expect(run.status).toBe("success");
    expect((run.result?.output as any).childOutput).toBe("received: 42");
  });
});
