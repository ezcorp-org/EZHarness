/**
 * substack-pilot — chat E2E (gap #4)
 *
 * Drives the real `executor.streamChat` → `ExtensionRegistry` → tool-loop
 * pipeline against a stub substack-pilot subprocess and a fake-LLM
 * `Agent` mock that emits a three-step tool-call sequence:
 *
 *   1. `substack-pilot__get_post_type({slug:"weekly"})`
 *   2. `substack-pilot__summarize_urls({urls:[…]})`
 *   3. `substack-pilot__generate_substack_draft({postTypeSlug:"weekly", urls:[…]})`
 *
 * followed by a final assistant text message containing the fake draft
 * URL the stub returned. This pins the host-side wiring of the extension's
 * seven tool names — namespacing as `substack-pilot__<tool>`, JSON-RPC
 * `tools/call` framing, isError-bit propagation — for the canonical
 * "use the weekly post type, here are URLs" flow that the README walks
 * through.
 *
 * Modeled directly on `chat-tool-loop-e2e.test.ts` (the host's own
 * tool-loop e2e), reusing the same MockAgent + setupTestDb + grant
 * `always_allow` settings pattern.
 *
 * What this test does NOT cover (handled elsewhere):
 *   - The real production handlers in `lib/{post-types,summarize,substack}.ts`
 *     — exercised by `docs/extensions/examples/substack-pilot/tests/*.test.ts`.
 *   - The real `createToolDispatcher` + `getChannel` channel — exercised
 *     by `docs/extensions/examples/substack-pilot/tests/dispatcher-integration.test.ts`.
 *   - Real-LLM round-trips through a running EZCorp instance — field-only.
 *
 * Scope of the stub subprocess (`helpers/substack-pilot-stub/`):
 *   - Mirrors `mock-extension/entrypoint.ts`'s JSON-RPC stdin/stdout loop.
 *   - Routes all seven tool names with canned responses whose shapes
 *     match the production handlers' contracts (postTypes[], postType,
 *     summaries[], draft envelope w/ mcpResponse).
 *   - Manifest in `helpers/substack-pilot-stub/ezcorp.config.ts` declares
 *     `name:"substack-pilot"` so the host's `extensions[]` ref resolves
 *     to the namespaced tool names a real install would produce.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";
import { resolve } from "node:path";
import type { AgentEvents } from "../types";

mockDbConnection();

// ── Module mocks (set BEFORE importing executor) ─────────────────

// Drives the multi-step tool-call sequence. Reset to 0 in each test.
let toolCallStep = 0;

// Track what the executor handed us as "available tools" so we can assert
// substack-pilot's seven tools all surfaced + got the correct namespace.
let lastObservedToolNames: string[] = [];

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "test-model",
    piModel: {
      id: "test-model",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    },
  }),
  ProviderUnavailableError: class extends Error {
    failedProvider: string;
    failedModel: string;
    suggestion: unknown;
    constructor(msg: string, fp: string, fm: string, sug: unknown) {
      super(msg);
      this.failedProvider = fp;
      this.failedModel = fm;
      this.suggestion = sug;
    }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

mock.module("@mariozechner/pi-ai", () => ({
  stream: () => ({
    [Symbol.asyncIterator]: async function* () {},
    result: async () => stubAssistantMessage(),
  }),
  complete: async () => stubAssistantMessage(),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

// Mock pi-agent-core Agent — drives the three substack-pilot tool calls
// then emits the final assistant text containing the draft URL.
mock.module("@mariozechner/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: null };
    private _subs: Array<(event: unknown) => void> = [];
    private _tools: Array<{
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        details: { isError: boolean };
      }>;
    }> = [];

    constructor(opts: {
      initialState?: {
        tools?: typeof MockAgent.prototype._tools;
      };
    }) {
      this._tools = opts.initialState?.tools ?? [];
      lastObservedToolNames = this._tools.map((t) => t.name);
    }

    subscribe(cb: (event: unknown) => void) {
      this._subs.push(cb);
      return () => {};
    }
    abort() {}

    async prompt() {
      // ── Step 1: get_post_type ───────────────────────────────
      // Step gating: in production pi-agent-core would re-call `prompt()`
      // after each tool result. Our MockAgent compresses that into one
      // pass — fire all three tool calls sequentially inside a single
      // `prompt()` so the executor's `subscribe` bridge sees the same
      // event stream it would for a real three-turn loop.
      toolCallStep++;

      if (toolCallStep === 1) {
        // 1a — get_post_type({slug:"weekly"})
        await this._callTool("substack-pilot__get_post_type", {
          slug: "weekly",
        });

        // 1b — summarize_urls({urls:[…]})
        await this._callTool("substack-pilot__summarize_urls", {
          urls: ["https://a.example/post1", "https://b.example/post2"],
        });

        // 1c — generate_substack_draft(…)
        const draftResult = await this._callTool(
          "substack-pilot__generate_substack_draft",
          {
            postTypeSlug: "weekly",
            urls: ["https://a.example/post1", "https://b.example/post2"],
          },
        );

        // Extract the draft URL the stub returned so the final
        // assistant text can echo it back — this is the artefact the
        // test asserts on. Production code wouldn't parse the tool
        // result this way (the LLM would); we shortcut for determinism.
        const draftText = draftResult.content[0]?.text ?? "{}";
        let draftUrl = "(unknown)";
        try {
          const parsed = JSON.parse(draftText) as {
            mcpResponse?: string;
          };
          const m = /draft=(\S+)/.exec(parsed.mcpResponse ?? "");
          if (m) draftUrl = m[1] ?? "(unknown)";
        } catch {
          // leave default
        }

        const finalText = `Created your weekly digest draft at ${draftUrl}.`;
        await this._emitFinalText(finalText);
        return;
      }

      // Fallback for any other turn — emit a benign assistant reply so
      // a stray re-entry doesn't hang the executor.
      await this._emitFinalText("ok");
    }

    private async _callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { isError: boolean };
    }> {
      const tool = this._tools.find((t) => t.name === name);
      if (!tool) {
        // Surface as a tool_error event so a missing-namespace bug shows
        // up loudly in the assertion phase instead of silently coercing
        // to an empty result.
        for (const sub of this._subs) {
          sub({
            type: "tool_execution_end",
            toolName: name,
            result: { content: [], isError: true },
            isError: true,
          });
        }
        return {
          content: [{ type: "text", text: `MISSING TOOL: ${name}` }],
          details: { isError: true },
        };
      }

      for (const sub of this._subs) {
        sub({ type: "tool_execution_start", toolName: name, args });
      }

      let result: {
        content: Array<{ type: "text"; text: string }>;
        details: { isError: boolean };
      };
      try {
        result = await tool.execute(
          `mock-call-${name}-${Date.now()}`,
          args,
        );
      } catch (err) {
        result = {
          content: [{ type: "text", text: String(err) }],
          details: { isError: true },
        };
      }

      for (const sub of this._subs) {
        sub({
          type: "tool_execution_end",
          toolName: name,
          result,
          isError: result.details.isError,
        });
      }
      return result;
    }

    private async _emitFinalText(text: string): Promise<void> {
      for (const sub of this._subs) {
        sub({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: text,
            partial: stubAssistantMessage(text),
          },
        });
      }
      const usage = {
        input: 20,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 32,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      for (const sub of this._subs) {
        sub({
          type: "turn_end",
          message: stubAssistantMessage(text, { usage }),
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
import { getDb } from "../db/connection";
import { agentConfigs } from "../db/schema";
import { eq } from "drizzle-orm";
import stubManifest from "./helpers/substack-pilot-stub/ezcorp.config";

const STUB_DIR = resolve(__dirname, "helpers/substack-pilot-stub");

const SUBSTACK_TOOL_NAMES = [
  "list_post_types",
  "get_post_type",
  "create_post_type",
  "update_post_type",
  "delete_post_type",
  "summarize_urls",
  "generate_substack_draft",
];

let extensionId: string;
let agentConfigId: string;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();

  const project = await createProject({
    name: "substack-pilot chat e2e",
    path: "/tmp/substack-pilot-chat-e2e",
  });
  projectId = project.id;

  // Register the stub extension under the production name so
  // namespaced tool names match what a real install would produce
  // (`substack-pilot__<tool>`).
  const ext = await createExtension({
    name: stubManifest.name,
    version: stubManifest.version,
    manifest: stubManifest,
    source: "local:/test",
    installPath: STUB_DIR,
  });
  extensionId = ext.id;

  const agent = await createAgentConfig({
    name: "substack-pilot-e2e-agent",
    description: "E2E test agent wired to substack-pilot.",
    prompt: "You are a test agent that uses the substack-pilot extension.",
  });
  agentConfigId = agent.id;

  await getDb()
    .update(agentConfigs)
    .set({ extensions: [extensionId] })
    .where(eq(agentConfigs.id, agentConfigId));

  // Grant the same `always_allow` capabilities chat-tool-loop-e2e grants.
  // The PermissionEngine fail-closes otherwise, so the first tool call
  // would surface as a deny before the stub even sees the JSON-RPC.
  await upsertSetting(`ext:${extensionId}:always_allow:shell`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:filesystem`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:storage`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:network`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:llm`, true);

  ExtensionRegistry.resetInstance();
  await ExtensionRegistry.getInstance().loadFromDb();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  restoreModuleMocks();
});

describe("substack-pilot — chat E2E (gap #4)", () => {
  test("multi-tool flow: get_post_type → summarize_urls → generate_substack_draft → final text", async () => {
    toolCallStep = 0;
    lastObservedToolNames = [];

    const conv = await createConversation(projectId, {
      title: "substack-pilot weekly draft",
    });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const toolEvents: Array<{ phase: "start" | "complete"; toolName: string; success?: boolean }> = [];
    bus.on("tool:start", (data) =>
      toolEvents.push({ phase: "start", toolName: data.toolName }),
    );
    bus.on("tool:complete", (data) =>
      toolEvents.push({
        phase: "complete",
        toolName: data.toolName,
        success: data.success,
      }),
    );

    const run = await executor.streamChat(
      conv.id,
      "![ext:substack-pilot] use the weekly post type, here are URLs: https://a.example/post1 https://b.example/post2",
      { agentConfigId },
    );

    // ── A. Executor surfaced all seven substack-pilot tools, namespaced ──
    //
    // This is the gap-#4 binding: agent config `extensions:[<id>]` →
    // ExtensionRegistry → `extensionToAgentTool` → pi-agent's
    // `initialState.tools`. The MockAgent captures the list in its
    // constructor. If `mention-wiring` ever stops wiring extension
    // tools when the extension is already in the agent config (a
    // realistic regression — see mention-wiring-EZ-strip.test.ts for
    // a similar deduplication concern), this assertion fails LOUD.
    for (const name of SUBSTACK_TOOL_NAMES) {
      const expected = `substack-pilot__${name}`;
      expect(lastObservedToolNames).toContain(expected);
    }

    // ── B. Run succeeded ─────────────────────────────────────────
    expect(run.status).toBe("success");

    // ── C. Final assistant text echoes the fake draft URL ────────
    const fullText = (run.result?.output as { fullText?: string })?.fullText ?? "";
    expect(fullText).toContain("https://example.substack.com/p/weekly-2026-05-11");

    // ── D. Three tool calls fired in order ───────────────────────
    //
    // We dedupe consecutive entries because the host's tool-start
    // bridge fires twice per call in this code path: once from the
    // `ToolExecutor.executeToolCall` site (the inner bus emit at
    // tool-executor.ts ~line 211's invocationId hook) and once from
    // the pi-agent-core subscribe-bridge (subscribe-bridge.ts —
    // pipes pi-agent's own `tool_execution_start` onto the bus). The
    // duplication is a real-world property of the bus stream and we
    // assert on the de-duped ORDER, not the raw event count.
    const starts = toolEvents.filter((e) => e.phase === "start").map((e) => e.toolName);
    const uniqueStartsInOrder: string[] = [];
    for (const name of starts) {
      if (uniqueStartsInOrder[uniqueStartsInOrder.length - 1] !== name) {
        uniqueStartsInOrder.push(name);
      }
    }
    expect(uniqueStartsInOrder).toEqual([
      "substack-pilot__get_post_type",
      "substack-pilot__summarize_urls",
      "substack-pilot__generate_substack_draft",
    ]);

    // ── E. Every tool call returned isError:false ────────────────
    //
    // tool:complete fires once per inner executor call (the bridge
    // doesn't double-emit completion). Three completes, all success.
    const completes = toolEvents.filter((e) => e.phase === "complete");
    // We tolerate >= 3 because the same dual-emit path that affects
    // `tool:start` *may* also surface for completes depending on
    // executor wiring; what we strictly require is "every observed
    // complete is success and at least three fired".
    expect(completes.length).toBeGreaterThanOrEqual(3);
    for (const c of completes) {
      expect(c.success).toBe(true);
    }
  });
});
