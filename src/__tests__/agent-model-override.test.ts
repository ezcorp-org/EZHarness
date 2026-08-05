/**
 * `AgentExecutor.runAgent`'s optional 5th argument — the model binding a
 * workflow step hands down — and the resolved binding it stamps back onto
 * the `AgentRun`.
 *
 * The binding is applied at ONE place, `createPiLlmAdapter`, so these
 * tests assert exactly that: what the adapter factory was constructed
 * with, and what `runAgent` did with the resolution it reported.
 */
import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { AgentDefinition, AgentEvents, ModelOverride } from "../types";

/** Every argument `createPiLlmAdapter` was constructed with, in order. */
const adapterArgs: Array<ModelOverride | undefined> = [];
/** What the next adapter reports as its resolved binding. */
let nextResolved: { provider: string; model: string } | undefined;
/** The effort-ignored sink `runAgent` handed the most recent adapter. */
let effortSink: ((message: string) => void) | undefined;
/** When set, the stub adapter fires the sink from inside `complete()` — the
 *  point in the real adapter where a dropped effort is discovered. */
let dropEffortMessage: string | undefined;

mock.module("../runtime/executor-helpers", () => ({
  createPiLlmAdapter: (overrides?: ModelOverride, onEffortIgnored?: (m: string) => void) => {
    adapterArgs.push(overrides);
    effortSink = onEffortIgnored;
    const adapter = {
      lastResolved: undefined as { provider: string; model: string } | undefined,
      async complete() {
        if (dropEffortMessage !== undefined) onEffortIgnored?.(dropEffortMessage);
        adapter.lastResolved = nextResolved;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *stream() {},
    };
    return adapter;
  },
  persistErrorMessage: async () => {},
  resolveFailoverAttempt: async () => {
    throw new Error("not used");
  },
}));

const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { loadAgentsStatic } = await import("../runtime/loader");

/** An agent that calls the LLM, like every `configToAgent`-built config. */
function llmAgent(name = "a"): AgentDefinition {
  return {
    name,
    description: "",
    capabilities: ["llm"],
    async execute(ctx) {
      const res = await ctx.llm.complete([{ role: "user", content: "hi" }], {
        system: "sys",
        provider: "anthropic",
        model: "agent-bound-model",
      });
      return { success: true, output: res.text };
    },
  };
}

/** An agent that never touches the LLM (a pure code agent). */
function silentAgent(): AgentDefinition {
  return {
    name: "silent",
    description: "",
    capabilities: ["custom"],
    async execute() {
      return { success: true, output: "no llm here" };
    },
  };
}

function setup(agents: AgentDefinition[]) {
  const bus = new EventBus<AgentEvents>();
  return new AgentExecutor(loadAgentsStatic(agents), bus);
}

beforeEach(() => {
  adapterArgs.length = 0;
  effortSink = undefined;
  dropEffortMessage = undefined;
  nextResolved = { provider: "anthropic", model: "resolved-model" };
});

describe("runAgent — model binding", () => {
  test("OMITTING the argument constructs the adapter with no override", async () => {
    // The compatibility guarantee at its narrowest: with nothing passed,
    // the adapter factory sees `undefined` and every downstream call is the
    // one it has always made (see pi-llm-adapter-model-override.test.ts).
    const executor = setup([llmAgent()]);
    const run = await executor.runAgent("a", {});
    expect(run.status).toBe("success");
    expect(adapterArgs).toEqual([undefined]);
  });

  test("an explicit undefined 5th argument is likewise no override", async () => {
    const executor = setup([llmAgent()]);
    await executor.runAgent("a", {}, undefined, undefined, undefined);
    expect(adapterArgs).toEqual([undefined]);
  });

  test("a supplied binding reaches the adapter verbatim", async () => {
    const executor = setup([llmAgent()]);
    const override: ModelOverride = { model: "claude-opus-5", maxTokens: 8000, effort: "high" };
    await executor.runAgent("a", {}, undefined, undefined, override);
    expect(adapterArgs).toEqual([override]);
  });

  test("stamps the RESOLVED provider/model onto the run", async () => {
    const executor = setup([llmAgent()]);
    const run = await executor.runAgent("a", {}, undefined, undefined, { model: "claude-opus-5" });
    expect(run.provider).toBe("anthropic");
    expect(run.model).toBe("resolved-model");
  });

  test("leaves provider/model unset for an agent that never called an LLM", async () => {
    const executor = setup([silentAgent()]);
    const run = await executor.runAgent("silent", {});
    expect(run.provider).toBeUndefined();
    expect(run.model).toBeUndefined();
  });

  test("records the binding a FAILED run tried to use", async () => {
    // The failure case is exactly when an operator needs to know which
    // model was in play, so the stamp lives in the `finally`.
    const executor = setup([
      {
        name: "boom",
        description: "",
        capabilities: ["llm"],
        async execute(ctx) {
          await ctx.llm.complete([{ role: "user", content: "hi" }], {});
          throw new Error("agent exploded");
        },
      },
    ]);
    const run = await executor.runAgent("boom", {});
    expect(run.status).toBe("error");
    expect(run.provider).toBe("anthropic");
    expect(run.model).toBe("resolved-model");
  });

  test("a nested ctx.run spawn does NOT inherit the parent's binding", async () => {
    // Identity (project/user) is inherited; a model binding is not — the
    // child agent may be deliberately bound to a different model.
    const parent: AgentDefinition = {
      name: "parent",
      description: "",
      capabilities: ["agent"],
      async execute(ctx) {
        await ctx.llm.complete([{ role: "user", content: "hi" }], {});
        return ctx.run("a", {});
      },
    };
    const executor = setup([parent, llmAgent()]);
    await executor.runAgent("parent", {}, undefined, undefined, { model: "claude-opus-5" });
    expect(adapterArgs).toEqual([{ model: "claude-opus-5" }, undefined]);
  });
});

/**
 * The channel a DROPPED `effort` comes out of.
 *
 * `effort` on a local/custom model is the one binding field whose failure was
 * pure silence — the model resolves with `reasoning: false`, pi-ai clamps the
 * level to "off" and drops the field before serializing, and nothing in the
 * request, the response or the run said so. `runAgent` gives the adapter the
 * run's own log to say it into, so it lands on `/runs/[id]` beside the step
 * that asked.
 */
describe("runAgent — a dropped effort reaches the run log", () => {
  test("the adapter is handed a sink, not left to log into the void", async () => {
    const executor = setup([llmAgent()]);
    await executor.runAgent("a", {}, undefined, undefined, { effort: "high" });
    expect(typeof effortSink).toBe("function");
  });

  test("what the adapter reports becomes a WARN entry on the run", async () => {
    dropEffortMessage = 'Reasoning effort "high" was ignored: the bound model ollama/qwen3 …';
    const executor = setup([llmAgent()]);
    const run = await executor.runAgent("a", {}, undefined, undefined, { effort: "high" });

    expect(run.status).toBe("success");
    const warnings = run.logs.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(dropEffortMessage);
  });

  test("an adapter that reports nothing leaves the run's logs untouched", async () => {
    // The overwhelmingly common case — a model that honours the effort, or a
    // step that asked for none. It must not cost a log line.
    const executor = setup([llmAgent()]);
    const run = await executor.runAgent("a", {}, undefined, undefined, { effort: "high" });
    expect(run.logs.filter((l) => l.level === "warn")).toEqual([]);
  });
});
