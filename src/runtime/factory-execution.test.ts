import { describe, expect, test } from "bun:test";
import {
  assertFactoryExecutionContext,
  createFactoryAgentRuntime,
  type FactoryBrokerRequest,
  type FactoryExecutionContext,
  type FactoryOperation,
  type FactoryOperationResult,
} from "./factory-execution";

// Direct unit tests for the factory execution adapter's refusal and journaling
// paths. The integration suite drives the happy path through a real agent; here
// every guard, failure, and journal hook is driven on its own with fakes.

type Recorder = {
  before: FactoryOperation[];
  after: FactoryOperationResult[];
  checkpoints: FactoryOperationResult[];
  requests: FactoryBrokerRequest[];
};

const message = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  model: "m",
  provider: "p",
  stopReason: "stop",
  usage: { input: 1, output: 1 },
} as const;

function stream(options: { iterate?: Error; result?: Error } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start" };
      if (options.iterate) throw options.iterate;
    },
    async result() {
      if (options.result) throw options.result;
      return message;
    },
  };
}

function context(overrides: Partial<FactoryExecutionContext> = {}, broker?: (request: FactoryBrokerRequest) => Promise<unknown>): { execution: FactoryExecutionContext; seen: Recorder } {
  const seen: Recorder = { before: [], after: [], checkpoints: [], requests: [] };
  const execution = {
    attempt: {
      attemptToken: "token",
      runId: "run-1",
      nodeInstanceId: "node-1",
      candidateGeneration: 2,
      cancellationEpoch: 0,
      requestDigest: "a".repeat(64),
      nextOperationIndex: 5,
    },
    model: { id: "model-1", provider: "provider-1" },
    broker: {
      stream: async (request: FactoryBrokerRequest) => {
        seen.requests.push(request);
        return (broker ? broker(request) : stream()) as never;
      },
    },
    journal: {
      before: async (operation: FactoryOperation) => void seen.before.push(operation),
      after: async (result: FactoryOperationResult) => void seen.after.push(result),
      checkpointWorkspace: async (result: FactoryOperationResult) => void seen.checkpoints.push(result),
    },
    ...overrides,
  } as unknown as FactoryExecutionContext;
  return { execution, seen };
}

const model = { id: "model-1", provider: "provider-1", api: "openai-completions" } as never;
const toolCall = (id: string) => ({ toolCall: { id, name: "read", arguments: {} }, args: { path: "a" } });

describe("assertFactoryExecutionContext", () => {
  const { execution } = context();
  const attempt = execution.attempt;
  test.each([
    ["no attempt token", { ...attempt, attemptToken: "" }],
    ["a request digest that is not 64 hex characters", { ...attempt, requestDigest: "A".repeat(64) }],
    ["no run id", { ...attempt, runId: "" }],
    ["no node instance", { ...attempt, nodeInstanceId: "" }],
    ["a fractional candidate generation", { ...attempt, candidateGeneration: 1.5 }],
    ["a negative candidate generation", { ...attempt, candidateGeneration: -1 }],
    ["a non-integer cancellation epoch", { ...attempt, cancellationEpoch: Number.NaN }],
    ["a negative cancellation epoch", { ...attempt, cancellationEpoch: -1 }],
    ["an unsafe operation index", { ...attempt, nextOperationIndex: Number.MAX_SAFE_INTEGER + 1 }],
    ["a negative operation index", { ...attempt, nextOperationIndex: -1 }],
  ])("rejects %s", (_label, badAttempt) => {
    expect(() => assertFactoryExecutionContext({ ...execution, attempt: badAttempt })).toThrow("Factory execution needs a complete attempt identity.");
  });
  test("rejects a model without an id or provider", () => {
    expect(() => assertFactoryExecutionContext({ ...execution, model: { provider: "p" } as never })).toThrow("complete attempt identity");
    expect(() => assertFactoryExecutionContext({ ...execution, model: { id: "m" } as never })).toThrow("complete attempt identity");
  });
  test.each(["before", "after", "checkpointWorkspace"] as const)("rejects a journal without %s", hook => {
    const journal = { ...execution.journal, [hook]: undefined };
    expect(() => assertFactoryExecutionContext({ ...execution, journal } as never)).toThrow("Factory execution needs a broker and all durable journal hooks.");
  });
  test("rejects a broker without stream, and accepts a complete context", () => {
    expect(() => assertFactoryExecutionContext({ ...execution, broker: {} as never })).toThrow("broker and all durable journal hooks");
    expect(() => assertFactoryExecutionContext(execution)).not.toThrow();
  });
});

describe("createFactoryAgentRuntime: model calls", () => {
  test("sends only JSON-safe options and tool metadata, and journals a completed result once", async () => {
    const { execution, seen } = context();
    const runtime = createFactoryAgentRuntime(execution);
    const tools = [
      { name: "read", description: "Read", parameters: { type: "object" }, execute: () => "host only" },
      { name: "strict", description: "Strict", parameters: { type: "object" }, constrainedSampling: true },
    ];
    const result = await runtime.streamFn(model, { systemPrompt: "sys", messages: [], tools } as never, { reasoning: "low", toolChoice: "auto", signal: new AbortController().signal } as never);
    for await (const _event of result) { /* drain */ }
    expect(await result.result()).toBe(message as never);
    expect(await result.result()).toBe(message as never);
    const request = seen.requests[0]!;
    expect(request.options).toEqual({ toolChoice: "auto", reasoning: "low" });
    expect(request.context).toEqual({
      systemPrompt: "sys",
      messages: [],
      tools: [
        { name: "read", description: "Read", parameters: { type: "object" } },
        { name: "strict", description: "Strict", parameters: { type: "object" }, constrainedSampling: true },
      ],
    } as never);
    expect(seen.before).toEqual([expect.objectContaining({ operationId: "run-1:node-1:2:5", operationIndex: 5, kind: "model", state: "prepared" })]);
    expect(seen.after).toEqual([expect.objectContaining({ operationId: "run-1:node-1:2:5", state: "completed", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  });

  test("a stream that fails while iterating is journaled failed and rethrown", async () => {
    const boom = new Error("stream broke");
    const { execution, seen } = context({}, async () => stream({ iterate: boom }));
    const result = await createFactoryAgentRuntime(execution).streamFn(model, { messages: [] } as never, undefined);
    await expect((async () => { for await (const _event of result) { /* drain */ } })()).rejects.toBe(boom);
    expect(seen.after).toEqual([expect.objectContaining({ state: "failed", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  });

  test("a stream whose result fails is journaled failed and rethrown, and a string error digests too", async () => {
    const { execution, seen } = context({}, async () => stream({ result: new Error("no result") }));
    const result = await createFactoryAgentRuntime(execution).streamFn(model, { messages: [] } as never, undefined);
    await expect(result.result()).rejects.toThrow("no result");
    expect(seen.after).toEqual([expect.objectContaining({ state: "failed" })]);

    const thrown = context({}, async () => { throw "broker down"; });
    await expect(createFactoryAgentRuntime(thrown.execution).streamFn(model, { messages: [] } as never, undefined)).rejects.toBe("broker down");
    expect(thrown.seen.after).toEqual([expect.objectContaining({ state: "failed", resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(thrown.seen.after[0]!.resultDigest).not.toBe(seen.after[0]!.resultDigest);
  });

  test("refuses an aborted signal and a host API key before any journal entry", async () => {
    const { execution, seen } = context();
    const runtime = createFactoryAgentRuntime(execution);
    const aborted = new AbortController();
    aborted.abort();
    await expect(runtime.streamFn(model, { messages: [] } as never, { signal: aborted.signal } as never)).rejects.toThrow("Factory attempt is aborted.");
    await expect(runtime.streamFn(model, { messages: [] } as never, { apiKey: "sk" } as never)).rejects.toThrow("Factory provider transport rejects host API keys.");
    expect(seen.before).toEqual([]);
  });

  test("refuses payloads that cannot cross the JSON broker boundary, naming the path", async () => {
    const runtime = createFactoryAgentRuntime(context().execution);
    await expect(runtime.streamFn(model, { messages: [{ role: "user", content: Number.POSITIVE_INFINITY }] } as never, undefined))
      .rejects.toThrow("Factory broker payload contains a non-finite number at $.messages[0].content.");
    await expect(runtime.streamFn(model, { messages: [{ role: "user", content: new Date(0) }] } as never, undefined))
      .rejects.toThrow("Factory broker payload contains a non-JSON value at $.messages[0].content.");
    // An absent object field is dropped, as JSON.stringify would; the call goes through.
    const { execution, seen } = context();
    await createFactoryAgentRuntime(execution).streamFn(model, { messages: [{ role: "user", content: "hi", note: undefined }] } as never, undefined);
    expect(seen.requests[0]!.context.messages).toEqual([{ role: "user", content: "hi" }] as never);
  });

  test("refuses to allocate an operation once the index namespace is exhausted", async () => {
    const { execution, seen } = context();
    const runtime = createFactoryAgentRuntime({ ...execution, attempt: { ...execution.attempt, nextOperationIndex: Number.MAX_SAFE_INTEGER } });
    await expect(runtime.streamFn(model, { messages: [] } as never, undefined)).rejects.toThrow("Factory attempt operation index is exhausted.");
    expect(seen.before).toEqual([]);
  });
});

describe("createFactoryAgentRuntime: tool calls", () => {
  test("pairs each tool result with its prepared operation, journals it, and checkpoints the workspace", async () => {
    const { execution, seen } = context();
    const runtime = createFactoryAgentRuntime(execution);
    expect(await runtime.beforeToolCall(toolCall("call-1") as never)).toBeUndefined();
    expect(await runtime.beforeToolCall(toolCall("call-2") as never)).toBeUndefined();
    expect(seen.before.map(operation => [operation.operationIndex, operation.kind])).toEqual([[5, "tool"], [6, "tool"]]);
    await runtime.afterToolCall({ ...toolCall("call-2"), result: { content: [], details: {} }, isError: true } as never);
    await runtime.afterToolCall({ ...toolCall("call-1"), result: { content: [{ type: "text", text: "ok" }], details: {} }, isError: false } as never);
    expect(seen.after.map(result => [result.operationIndex, result.state])).toEqual([[6, "failed"], [5, "completed"]]);
    expect(seen.checkpoints).toEqual(seen.after);
    await expect(runtime.afterToolCall({ ...toolCall("call-1"), result: { content: [], details: {} }, isError: false } as never))
      .rejects.toThrow("Factory tool result has no prepared journal operation.");
  });
});
