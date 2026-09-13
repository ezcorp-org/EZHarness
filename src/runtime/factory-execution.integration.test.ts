import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { buildPiAgent } from "./stream-chat/build-pi-agent";
import { createStreamChatContext } from "./stream-chat/context";
import { runWithFailover } from "./stream-chat/failover";
import { resolveModelTierAndCredential } from "./stream-chat/setup-tools";
import { AgentExecutor } from "./executor";
import {
  assertFactoryExecutionContext,
  createFactoryAgentRuntime,
  type FactoryBrokerRequest,
  type FactoryExecutionContext,
  type FactoryOperationResult,
} from "./factory-execution";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const model = {
  id: "brokered-model",
  provider: "factory-broker",
  api: "pi-messages",
  contextWindow: 16_384,
  maxTokens: 1_024,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<any>;

function assistant(content: AssistantMessage["content"], stopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "pi-messages",
    provider: "factory-broker",
    model: "brokered-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: 1,
  };
}

function resultStream(message: AssistantMessage): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {},
    async result() { return message; },
  } as unknown as AssistantMessageEventStream;
}

function factory(
  broker: (request: FactoryBrokerRequest) => Promise<AssistantMessageEventStream>,
  events: string[],
  overrides: Partial<FactoryExecutionContext["journal"]> = {},
): FactoryExecutionContext {
  return {
    attempt: { attemptToken: "attempt-token", runId: "run-1", nodeInstanceId: "node-1", candidateGeneration: 2, nextOperationIndex: 7 },
    model,
    broker: { stream: broker },
    journal: {
      before: async (operation) => { events.push(`before:${operation.state}:${operation.kind}:${operation.operationId}`); },
      after: async (operation) => { events.push(`after:${operation.kind}:${operation.state}:${operation.operationId}`); },
      checkpointWorkspace: async (operation) => { events.push(`checkpoint:${operation.operationId}`); },
      ...overrides,
    },
  };
}

test("factory build path journals a real temporary-workspace tool before its effect and never fetches a host key", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "factory-executor-"));
  temporaryDirectories.push(workspace);
  const events: string[] = [];
  const requests: FactoryBrokerRequest[] = [];
  const replies = [
    assistant([{ type: "toolCall", id: "write-1", name: "write_file", arguments: { path: "result.txt", text: "factory bytes" } }], "toolUse"),
    assistant([{ type: "text", text: "done" }]),
  ];
  const execution = factory(async (request) => {
    events.push(`broker:${request.operation.operationId}`);
    requests.push(request);
    return resultStream(replies.shift()!);
  }, events);
  execution.journal.checkpointWorkspace = async (operation) => {
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("factory bytes");
    events.push(`checkpoint:${operation.operationId}`);
  };

  const ctx = createStreamChatContext(
    { id: "chat-run", agentName: "chat", status: "running", startedAt: 1, logs: [] },
    new AbortController(),
    undefined,
  );
  ctx.agentTools = [{
    name: "write_file",
    description: "write a file",
    parameters: { type: "object" } as any,
    execute: async (_id: string, args: { path: string; text: string }) => {
      events.push("effect:write_file");
      await writeFile(join(workspace, args.path), args.text);
      return { content: [{ type: "text", text: "written" }], details: {} };
    },
  }] as any;
  const agent = buildPiAgent(
    ctx,
    [],
    { factoryExecution: execution, thinkingLevel: "off" },
    { resolved: { provider: model.provider, model: model.id, piModel: model }, initialCred: { type: "apikey", token: "host-key-must-not-be-read" } as any, effectiveTier: "balanced" },
    "credential-conversation",
    "conversation",
  );
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") events.push(`ack:${event.toolCallId}`);
  });

  await agent.prompt("make the file");

  expect(agent.getApiKey).toBeUndefined();
  expect(requests.map((request) => request.operation.operationId)).toEqual([
    "run-1:node-1:2:7",
    "run-1:node-1:2:9",
  ]);
  expect(requests.every((request) => !("apiKey" in request.options) && !("getApiKey" in request.options) && !("onPayload" in request.options))).toBe(true);
  expect(requests.every((request) => request.operation.state === "prepared")).toBe(true);
  expect(events.indexOf("before:prepared:tool:run-1:node-1:2:8")).toBeLessThan(events.indexOf("effect:write_file"));
  expect(events.indexOf("effect:write_file")).toBeLessThan(events.indexOf("after:tool:completed:run-1:node-1:2:8"));
  expect(events.indexOf("after:tool:completed:run-1:node-1:2:8")).toBeLessThan(events.indexOf("checkpoint:run-1:node-1:2:8"));
  expect(events.indexOf("checkpoint:run-1:node-1:2:8")).toBeLessThan(events.indexOf("ack:write-1"));
});

test("factory transport fails closed before a broker call on abort, host key, missing hooks, or failed journal", async () => {
  const events: string[] = [];
  let brokerCalls = 0;
  const execution = factory(async () => {
    brokerCalls += 1;
    return resultStream(assistant([{ type: "text", text: "unreachable" }]));
  }, events, { before: async () => { throw new Error("journal unavailable"); } });
  const runtime = createFactoryAgentRuntime(execution);
  const controller = new AbortController();
  controller.abort();

  await expect(runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, { signal: controller.signal } as any)).rejects.toThrow("aborted");
  await expect(runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "host-secret" } as any)).rejects.toThrow("rejects host API keys");
  await expect(runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, { toolChoice: "auto", reasoning: "low", deferred: true, thinkingBudgets: { low: 10 } } as any)).rejects.toThrow("journal unavailable");
  expect(brokerCalls).toBe(0);
  await expect(runtime.afterToolCall({ toolCall: { id: "missing" }, result: { content: [] }, isError: false } as any)).rejects.toThrow("no prepared journal");
  expect(() => assertFactoryExecutionContext({ ...execution, journal: { ...execution.journal, checkpointWorkspace: undefined } } as any)).toThrow("all durable journal hooks");
  expect(() => assertFactoryExecutionContext({
    ...execution,
    attempt: { ...execution.attempt, attemptToken: "" },
  })).toThrow("complete attempt identity");

  let toolEffect = false;
  const replies = [
    assistant([{ type: "toolCall", id: "blocked-tool", name: "effect", arguments: {} }], "toolUse"),
    assistant([{ type: "text", text: "tool was blocked" }]),
  ];
  const toolExecution = factory(async () => resultStream(replies.shift()!), events, {
    before: async (operation) => {
      if (operation.kind === "tool") throw new Error("tool journal unavailable");
    },
  });
  const toolRuntime = createFactoryAgentRuntime(toolExecution);
  const toolAgent = new Agent({
    initialState: { systemPrompt: "", model, tools: [{ name: "effect", description: "must not run", parameters: { type: "object" } as any, execute: async () => { toolEffect = true; return { content: [] }; } } as any], messages: [], thinkingLevel: "off" },
    streamFn: toolRuntime.streamFn,
    beforeToolCall: toolRuntime.beforeToolCall,
    afterToolCall: toolRuntime.afterToolCall,
    convertToLlm: (messages) => messages as any,
  });
  await toolAgent.prompt("try effect");
  expect(toolEffect).toBe(false);
});

test("factory records failed broker and stream results without retrying the provider", async () => {
  const events: string[] = [];
  const recorded: FactoryOperationResult[] = [];
  const execution = factory(
    async () => { throw new Error("broker unavailable"); },
    events,
    { after: async (operation) => { recorded.push(operation); } },
  );
  const runtime = createFactoryAgentRuntime(execution);
  await expect(runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, {})).rejects.toThrow("broker unavailable");

  execution.broker.stream = async () => ({
    async *[Symbol.asyncIterator]() { yield await Promise.reject(new Error("stream broke")); },
    async result() { throw new Error("result broke"); },
  } as unknown as AssistantMessageEventStream);
  const broken = await runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, {});
  await expect((async () => { for await (const _event of broken) { /* stream is expected to reject */ } })()).rejects.toThrow("stream broke");
  await expect(broken.result()).rejects.toThrow("result broke");

  expect(recorded.map((operation) => operation.state)).toEqual(["failed", "failed"]);
  expect(recorded.map((operation) => operation.operationId)).toEqual([
    "run-1:node-1:2:7",
    "run-1:node-1:2:8",
  ]);
});

test("a rejected durable stream settlement rejects every concurrent result caller", async () => {
  const events: string[] = [];
  let afterCalls = 0;
  const execution = factory(async () => resultStream(assistant([{ type: "text", text: "reply" }])), events, {
    after: async () => {
      afterCalls += 1;
      throw new Error("journal after failed");
    },
  });
  const runtime = createFactoryAgentRuntime(execution);
  const stream = await runtime.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, {});
  const first = stream.result();
  const second = stream.result();
  const results = await Promise.allSettled([first, second]);
  expect(afterCalls).toBe(1);
  expect(results).toEqual([
    { status: "rejected", reason: expect.objectContaining({ message: "journal after failed" }) },
    { status: "rejected", reason: expect.objectContaining({ message: "journal after failed" }) },
  ]);
});

test("factory rejects non-JSON broker payloads and exhausted operation indexes before hooks", async () => {
  const events: string[] = [];
  let beforeCalls = 0;
  const execution = factory(async () => resultStream(assistant([{ type: "text", text: "reply" }])), events, {
    before: async () => { beforeCalls += 1; },
  });
  const runtime = createFactoryAgentRuntime(execution);
  await expect(runtime.streamFn({ ...model, invalid: () => undefined } as any, { systemPrompt: "", messages: [], tools: [] }, {})).rejects.toThrow("non-JSON");
  expect(beforeCalls).toBe(0);

  const exhausted = createFactoryAgentRuntime({
    ...execution,
    attempt: { ...execution.attempt, nextOperationIndex: Number.MAX_SAFE_INTEGER },
  });
  await expect(exhausted.streamFn(model, { systemPrompt: "", messages: [], tools: [] }, {})).rejects.toThrow("index is exhausted");
  expect(beforeCalls).toBe(0);
});

test("factory entrypoint bypasses host credential resolution and disables executor failover", async () => {
  const events: string[] = [];
  const execution = factory(async () => resultStream(assistant([{ type: "text", text: "unused" }])), events);
  const setupRun = { id: "setup", agentName: "chat", status: "running", startedAt: 1, logs: [] } as any;
  const setup = await resolveModelTierAndCredential(setupRun, "ignored", { factoryExecution: execution }, null, "host-credential-conversation");
  expect(setup.resolved.piModel).toBe(model);
  expect(setup.initialCred.token).toBe("");

  const calls: unknown[][] = [];
  const result = { id: "factory-run" } as any;
  const started = await AgentExecutor.prototype.executeFactoryAttempt.call({
    streamChat: async (...args: unknown[]) => { calls.push(args); return result; },
  }, { conversationId: "conversation", userMessage: "work", execution });
  expect(started).toBe(result);
  expect(calls[0]?.[2]).toMatchObject({ factoryExecution: execution });

  const ctx = createStreamChatContext(setupRun, new AbortController(), undefined);
  const failedAgent = { state: { errorMessage: "temporary provider failure" } } as Agent;
  let fallbackCalls = 0;
  await expect(runWithFailover({
    ctx,
    host: { activeAgents: new Map() } as any,
    runId: "factory-run",
    tier: "balanced",
    initial: { provider: model.provider, model: model.id, resolved: setup },
    allowFailover: false,
    buildAgent: () => failedAgent,
    subscribe: () => {},
    runPrompt: async () => {},
    suggestFallback: async () => { fallbackCalls += 1; return null; },
    resolveAttempt: async () => { throw new Error("factory must not resolve a fallback"); },
  })).rejects.toThrow("temporary provider failure");
  expect(fallbackCalls).toBe(0);
});
