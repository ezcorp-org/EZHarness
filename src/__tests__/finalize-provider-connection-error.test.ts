/**
 * Integration coverage for the connection-error translation inside the
 * REAL `finalizeError` / `finalizeSetupError` paths.
 *
 * Regression guard for the chat bubble "Error: Was there a typo in the url
 * or port?". The real-world trigger was a container with broken DNS/egress:
 * a gpt-5.5 (OAuth Codex) turn couldn't resolve `chatgpt.com`, so the LLM
 * `fetch` failed and the runtime's raw connection text leaked verbatim into
 * chat. The class of failure is identical for any unreachable endpoint
 * (Ollama/custom localhost, a refused socket, a DNS miss), so the cases
 * below cover both shapes. These tests drive the actual finalize helpers
 * (only the leaf DB writes are mocked) and assert the persisted assistant
 * message is the friendly, actionable rewrite and NEVER the raw runtime text.
 *
 * Harness mirrors `finalize-error-persist-slot.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mocked DB sinks (must precede SUT import) ──────────────────────────

interface CreatedMessage {
  conversationId: string;
  role: string;
  content: string;
  runId?: string;
}
const createdMessages: CreatedMessage[] = [];

mock.module("../db/queries/conversations", () => ({
  createMessage: async (
    conversationId: string,
    data: { role: string; content: string; runId?: string },
  ) => {
    const msg = {
      id: `msg-${createdMessages.length + 1}`,
      conversationId,
      role: data.role,
      content: data.content,
      runId: data.runId,
    };
    createdMessages.push(msg);
    return msg;
  },
}));

const chainNoop = {
  update: () => chainNoop,
  set: () => chainNoop,
  where: async () => undefined,
};
mock.module("../db/connection", () => ({ getDb: () => chainNoop }));

mock.module("../db/queries/active-runs", () => ({
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  markInterrupted: async () => {},
  cleanupOrphanedRuns: async () => 0,
  interruptAllRuns: async () => 0,
  getActiveRun: async () => null,
  deleteActiveRun: async () => {},
}));
mock.module("../db/queries/runs", () => ({
  finalizeRunRow: async () => 1,
  terminalizeOrphanedRuns: async () => 0,
  updateRun: async () => {},
}));

import {
  finalizeError,
  finalizeSetupError,
} from "../runtime/stream-chat/finalize";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { StreamChatHost } from "../runtime/stream-chat/host";
import type { StreamChatContext } from "../runtime/stream-chat/context";

// ── Harness ────────────────────────────────────────────────────────────

const RUN_ID = "run-conn-1";
const CONV_ID = "conv-conn-1";

// The exact runtime string the user reported (Bun 1.3.x ConnectionRefused).
const RAW_BUN_MESSAGE = "Was there a typo in the url or port?";

function makeRun(provider?: string): AgentRun {
  return {
    id: RUN_ID,
    agentName: "chat",
    status: "running",
    startedAt: 1_000,
    logs: [],
    provider,
  };
}

interface Harness {
  host: StreamChatHost;
  runErrors: string[];
}

function makeHarness(): Harness {
  const bus = new EventBus<AgentEvents>();
  const runErrors: string[] = [];
  bus.on("run:error", (d) => runErrors.push((d as { error: string }).error));
  const controllers = new Map<string, AbortController>();
  controllers.set(RUN_ID, new AbortController());
  const host = {
    bus,
    persist: true,
    pendingPermissions: new Map(),
    controllers,
    runConversations: new Map([[RUN_ID, CONV_ID]]),
    activeAgents: new Map(),
    runs: new Map(),
    watchdog: { clearRun: () => {} },
    errorMessagePersisted: new Set<string>(),
    stateMediator: undefined,
    spawnQuota: {} as unknown,
    executor: {} as unknown,
    permissionEngine: {} as unknown,
  } as unknown as StreamChatHost;
  return { host, runErrors };
}

function makeCtx(run: AgentRun, modelBaseUrl?: string): StreamChatContext {
  return {
    run,
    modelBaseUrl,
    lastSavedMessageId: null,
    allTurnsText: "",
    turnText: "",
    dbQueue: Promise.resolve(),
    turnStart: 1_000,
    totalUsage: { input: 0, output: 0 },
  } as unknown as StreamChatContext;
}

beforeEach(() => {
  createdMessages.length = 0;
});

// ── finalizeError ──────────────────────────────────────────────────────

describe("finalizeError translates provider connection failures", () => {
  test("raw Bun 'typo in the url' text → friendly message naming the endpoint", async () => {
    const h = makeHarness();
    const run = makeRun("ollama");

    await finalizeError(
      makeCtx(run, "http://localhost:11434/v1"),
      h.host,
      CONV_ID,
      { model: "gemma4:31b", provider: "ollama" },
      new Error(RAW_BUN_MESSAGE),
    );

    expect(run.status).toBe("error");
    const assistant = createdMessages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    const content = assistant[0]!.content;
    // The cryptic raw text must NOT reach the chat bubble…
    expect(content).not.toContain("typo in the url");
    // …it's replaced by an actionable message naming provider/model/url.
    expect(content).toContain("Couldn't reach");
    expect(content).toContain("ollama");
    expect(content).toContain("gemma4:31b");
    expect(content).toContain("http://localhost:11434/v1");
    // run:error carries the same rewritten text (rendering path unchanged).
    expect(h.runErrors).toHaveLength(1);
    expect(h.runErrors[0]).not.toContain("typo in the url");
  });

  test("falls back to provider from run.provider when options omits it", async () => {
    const h = makeHarness();
    const run = makeRun("ollama");

    await finalizeError(
      makeCtx(run, "http://localhost:11434/v1"),
      h.host,
      CONV_ID,
      { model: "gemma4:31b" }, // no provider in options
      new Error("connect ECONNREFUSED 127.0.0.1:11434"),
    );

    const content = createdMessages.find((m) => m.role === "assistant")!.content;
    expect(content).toContain("ollama");
  });

  test("real incident: gpt-5.5 OAuth turn with broken DNS → friendly message", async () => {
    const h = makeHarness();
    const run = makeRun("openai");

    // pi-agent-core flattens the underlying fetch error to its message
    // string, which the executor rethrows as `new Error(string)`.
    await finalizeError(
      makeCtx(run, "https://chatgpt.com/backend-api"),
      h.host,
      CONV_ID,
      { model: "gpt-5.5", provider: "openai" },
      new Error("Unable to connect. Is the computer able to access the url?"),
    );

    const content = createdMessages.find((m) => m.role === "assistant")!.content;
    expect(content).not.toContain("typo in the url");
    expect(content).not.toContain("Unable to connect");
    expect(content).toContain("Couldn't reach");
    expect(content).toContain("openai");
    expect(content).toContain("gpt-5.5");
    expect(content).toContain("https://chatgpt.com/backend-api");
    expect(content.toLowerCase()).toContain("network/dns");
  });

  test("non-connection errors pass through unchanged", async () => {
    const h = makeHarness();
    const run = makeRun("anthropic");

    await finalizeError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "claude-x", provider: "anthropic" },
      new Error("401 Unauthorized: invalid API key"),
    );

    const content = createdMessages.find((m) => m.role === "assistant")!.content;
    expect(content).toContain("401 Unauthorized");
    expect(content).not.toContain("Couldn't reach");
  });
});

// ── finalizeSetupError ─────────────────────────────────────────────────

describe("finalizeSetupError translates provider connection failures", () => {
  test("connection failure during setup → friendly message", async () => {
    const h = makeHarness();
    const run = makeRun("ollama");

    await finalizeSetupError(
      makeCtx(run, "http://localhost:11434/v1"),
      h.host,
      CONV_ID,
      { model: "gemma4:31b", provider: "ollama" },
      new Error(RAW_BUN_MESSAGE),
    );

    expect(run.status).toBe("error");
    const content = createdMessages.find((m) => m.role === "assistant")!.content;
    expect(content).not.toContain("typo in the url");
    expect(content).toContain("Couldn't reach");
    expect(content).toContain("ollama");
  });

  test("non-connection setup error passes through unchanged", async () => {
    const h = makeHarness();
    const run = makeRun("p");

    await finalizeSetupError(
      makeCtx(run),
      h.host,
      CONV_ID,
      { model: "m", provider: "p" },
      new Error("credential resolution failed"),
    );

    const content = createdMessages.find((m) => m.role === "assistant")!.content;
    expect(content).toContain("credential resolution failed");
    expect(content).not.toContain("Couldn't reach");
  });
});
