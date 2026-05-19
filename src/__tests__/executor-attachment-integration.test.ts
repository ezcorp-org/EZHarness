/**
 * Behavioral integration: the full streamChat → tool-call → handle-resolver
 * round trip. Confirms that an `ez-attachment://<id>` handle the LLM echoes
 * into tool args actually reaches the extension subprocess as a real
 * `data:<mime>;base64,<bytes>` URI.
 *
 * The mock agent (see `chat-tool-loop-e2e.test.ts` for the established
 * pattern) captures args at the tool boundary — we replay that harness
 * but pass `options.attachments` into streamChat and a handle into the
 * simulated tool call. If the executor's wiring is correct, the echo
 * subprocess returns the resolved data URI in its result payload.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { AgentEvents } from "../types";

mockDbConnection();

// Deterministic: agent emits one tool call with args we control via the
// module-level `nextToolArgs` slot. That mirrors the harness in
// chat-tool-loop-e2e.test.ts (single-turn, single-tool).
let nextToolArgs: Record<string, unknown> = {};
let lastToolResult: any = null;

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "test-model",
    piModel: { id: "test-model", provider: "anthropic", api: "anthropic-messages", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
  }),
  ProviderUnavailableError: class extends Error {
    failedProvider: string; failedModel: string; suggestion: any;
    constructor(msg: string, fp: string, fm: string, sug: any) { super(msg); this.failedProvider = fp; this.failedModel = fm; this.suggestion = sug; }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

// Annotated with Model<Api> so new required fields in pi-ai surface as
// compile errors here rather than runtime surprises. "image" in `input` is
// load-bearing — content-builder reads it to pick the handle-ref delivery
// strategy.
const MOCK_MODEL: Model<Api> = {
  id: "test-model",
  name: "test-model",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

mock.module("@mariozechner/pi-ai", () => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => stubAssistantMessage() }),
  complete: async () => stubAssistantMessage(),
  getModel: () => MOCK_MODEL,
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
  Type: { Unsafe: (v: any) => v, Object: (v: any) => v, String: () => ({}), Number: () => ({}), Boolean: () => ({}), Array: () => ({}) },
}));

mock.module("@mariozechner/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: null };
    private _subs: any[] = [];
    private _tools: any[] = [];
    constructor(opts: any) { this._tools = opts.initialState?.tools ?? []; }
    subscribe(cb: any) { this._subs.push(cb); return () => {}; }
    abort() {}
    async prompt() {
      if (this._tools.length === 0) return;
      const tool = this._tools[0];
      for (const sub of this._subs) {
        sub({ type: "tool_execution_start", toolName: tool.name, args: nextToolArgs });
      }
      try {
        lastToolResult = await tool.execute("test-call-id", nextToolArgs);
      } catch (err) {
        lastToolResult = { error: String(err) };
      }
      for (const sub of this._subs) {
        sub({ type: "tool_execution_end", toolName: tool.name, result: lastToolResult, isError: false });
      }
      for (const sub of this._subs) {
        sub({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done", partial: stubAssistantMessage("done") },
        });
      }
      for (const sub of this._subs) {
        sub({
          type: "turn_end",
          message: stubAssistantMessage("done", { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
        });
      }
    }
  },
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { createExtension } from "../db/queries/extensions";
import { createAgentConfig } from "../db/queries/agent-configs";
import { ExtensionRegistry } from "../extensions/registry";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import { upsertSetting } from "../db/queries/settings";
import { writeAttachment } from "../chat/attachments/storage";
import { getDb } from "../db/connection";
import { agentConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import { attachmentHandle, type StagedAttachment } from "../chat/attachments/content-builder";

const MOCK_EXT_DIR = resolve(__dirname, "helpers/mock-extension");
const IMAGE_BYTES = new TextEncoder().encode("REAL-IMAGE-BYTES");
const EXPECTED_B64 = Buffer.from(IMAGE_BYTES).toString("base64");

let extensionId: string;
let agentConfigId: string;
let projectId: string;
let projectRoot: string;

beforeAll(async () => {
  await setupTestDb();
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-attint-"));
  const project = await createProject({ name: "Att Integration", path: projectRoot });
  projectId = project.id;

  const ext = await createExtension({
    name: "e2e-echo",
    version: "1.0.0",
    manifest: {
      schemaVersion: "2.0",
      name: "e2e-echo", version: "1.0.0",
      author: "e2e-test",
      description: "E2E test extension",
      entrypoint: "./entrypoint.ts",
      tools: [{ name: "echo", description: "Echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
      permissions: {},
    } as any,
    source: "local:/test",
    installPath: MOCK_EXT_DIR,
  });
  extensionId = ext.id;

  const agent = await createAgentConfig({
    name: "attachment-int-agent",
    description: "integration test agent",
    prompt: "You are a test agent with tools.",
  });
  agentConfigId = agent.id;

  await getDb()
    .update(agentConfigs)
    .set({ extensions: [extensionId] })
    .where(eq(agentConfigs.id, agentConfigId));

  await upsertSetting(`ext:${extensionId}:always_allow:shell`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:filesystem`, true);

  ExtensionRegistry.resetInstance();
  await ExtensionRegistry.getInstance().loadFromDb();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  restoreModuleMocks();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

function extractToolText(result: any): string {
  const content = result?.content ?? [];
  for (const c of content) if (typeof c?.text === "string") return c.text;
  return "";
}

describe("streamChat attachment-handle integration", () => {
  test("handle echoed by the LLM reaches the subprocess as a data URI", async () => {
    const conv = await createConversation(projectId, { title: "integration", userId: undefined });
    const written = await writeAttachment({
      projectRoot, conversationId: conv.id, messageId: "will-assign",
      filename: "cow.png", mimeType: "image/png", bytes: IMAGE_BYTES,
    });
    const staged: StagedAttachment = {
      id: "int-att-1",
      filename: "cow.png",
      mimeType: "image/png",
      storagePath: written.storagePath,
    };
    nextToolArgs = { text: attachmentHandle(staged.id) };
    lastToolResult = null;

    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);
    const run = await executor.streamChat(conv.id, "use the handle", {
      agentConfigId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      projectId,
      attachments: [staged],
    });

    expect(run.status).toBe("success");
    // echo subprocess echoes the (resolved) `text` arg back in the tool result.
    expect(extractToolText(lastToolResult)).toBe(`data:image/png;base64,${EXPECTED_B64}`);
  });

  test("unknown handle passes through verbatim (tool sees the raw handle)", async () => {
    const conv = await createConversation(projectId, { title: "int-unknown", userId: undefined });
    const written = await writeAttachment({
      projectRoot, conversationId: conv.id, messageId: "will-assign",
      filename: "cow.png", mimeType: "image/png", bytes: IMAGE_BYTES,
    });
    const staged: StagedAttachment = {
      id: "int-att-known",
      filename: "cow.png",
      mimeType: "image/png",
      storagePath: written.storagePath,
    };
    // LLM cites an id that was NOT staged this turn — resolver has nothing
    // to swap with, so the tool observes the literal handle and can fail
    // in its own validation layer rather than silently succeeding on
    // spoofed content.
    nextToolArgs = { text: "ez-attachment://not-a-real-id" };
    lastToolResult = null;

    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);
    await executor.streamChat(conv.id, "spoof", {
      agentConfigId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      projectId,
      attachments: [staged],
    });

    expect(extractToolText(lastToolResult)).toBe("ez-attachment://not-a-real-id");
  });

  test("no attachments in options → handle in args passes through unchanged (no-op resolver)", async () => {
    const conv = await createConversation(projectId, { title: "int-noatt", userId: undefined });
    nextToolArgs = { text: "ez-attachment://anything" };
    lastToolResult = null;

    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);
    await executor.streamChat(conv.id, "no attachments", {
      agentConfigId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      projectId,
      // no `attachments` field, no past-turn attachments on this branch.
    });

    expect(extractToolText(lastToolResult)).toBe("ez-attachment://anything");
  });
});
