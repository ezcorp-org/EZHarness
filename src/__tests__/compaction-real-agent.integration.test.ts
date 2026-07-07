/**
 * Integration test: the REAL `@earendil-works/pi-agent-core` Agent — built via
 * the production `buildPiAgent` path — applies the compaction
 * `transformContext` hook before EVERY LLM call, and never mutates
 * `model.maxTokens` (input-only trimming) end-to-end.
 *
 * WHY THIS EXISTS (audit gap MEDIUM-8)
 * ------------------------------------
 * The no-mutate-`maxTokens` + trim invariants were previously only asserted
 * against a STUBBED Agent (`build-pi-agent-compaction.test.ts`), which captures
 * the `transformContext` callback from the constructor options and invokes it by
 * hand. Nothing proved that the REAL pi-agent-core Agent actually calls that hook
 * before each LLM call. A pi-agent-core upgrade that stopped applying
 * `transformContext` would silently re-introduce the `context_length_exceeded`
 * dead-end for long threads — with every existing compaction test still green.
 *
 * The only end-to-end proof today is `web/e2e/chat-context-compaction.spec.ts`,
 * which is `test.describe.skip` (needs a docker storageState — not CI-runnable).
 *
 * HOW THIS CLOSES THE GAP (cheaper + stronger, fully CI-runnable)
 * --------------------------------------------------------------
 * We drive a REAL Agent — real default `streamFn` (pi-ai's `streamSimple` HTTP
 * client), real `buildPiAgent` wiring, real trim strategy — against a loopback
 * `Bun.serve` mock-LLM that RECORDS the exact request body it receives on the
 * wire. We seed an over-long history, run a turn, and assert the messages the
 * LLM ACTUALLY received were trimmed by `transformContext`:
 *   - a compaction marker (`[Context note: … omitted …]`) is present,
 *   - the message count is far below what we seeded,
 *   - the active turn (final user prompt) is preserved.
 * If the real Agent did NOT apply the hook, the server would have received the
 * full untrimmed history with no marker — so this fails loudly on a
 * hook-application regression (which the stubbed test cannot detect).
 *
 * A second scenario forces an agentic tool loop (toolCall turn → toolResult →
 * second LLM call) and asserts BOTH wire requests were trimmed — proving the
 * hook fires before EACH LLM call, not merely the first.
 *
 * The `model.maxTokens` invariant is asserted end-to-end: after a full real
 * turn through build + transform + agent loop + wire call, both the original
 * model object and `agent.state.model` still carry the untouched value.
 *
 * The observation point is the mock LLM's recorded request body — NOT a stubbed
 * Agent and NOT the transform invoked by hand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { buildPiAgent } from "../runtime/stream-chat/build-pi-agent";
import { resolveModelObject } from "../providers/registry";
import { MOCK_PROVIDER } from "../test-surface";
// The mock-LLM module is pure (no web aliases) — safe to import from src,
// same as `mock-llm-pi-ai.integration.test.ts`.
import {
  buildMockStreamResponse,
  dequeueMockTurn,
  mockScriptKeyFromModel,
  setMockScript,
  type MockTurn,
} from "../../web/src/lib/server/mock-llm";

// ── Loopback mock-LLM server that records every wire request ──────────

interface RecordedRequest {
  model: unknown;
  messages: Array<{ role: string; content: unknown }>;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let recorded: RecordedRequest[] = [];

// isTestSurfaceEnabled() gates the MOCK_PROVIDER credential short-circuit in
// getCredential() (returns a sentinel token, no DB access). Set the three
// required env flags for the duration of this suite and restore afterwards.
const envKeys = ["PI_E2E_REAL", "EZCORP_ALLOW_TEST_SURFACE", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.env.PI_E2E_REAL = "1";
  process.env.EZCORP_ALLOW_TEST_SURFACE = "1";
  process.env.NODE_ENV = "test";

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as {
          model?: unknown;
          messages?: Array<{ role: string; content: unknown }>;
        };
        // Record the EXACT payload the real Agent put on the wire — this is
        // the post-transformContext, post-convertToLlm context.
        recorded.push({ model: body.model, messages: body.messages ?? [] });
        return buildMockStreamResponse(dequeueMockTurn(mockScriptKeyFromModel(body.model)));
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  recorded = [];
});

afterAll(() => {
  server.stop(true);
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Fixtures ──────────────────────────────────────────────────────────

const MARKER_PREFIX = "[Context note:";

/**
 * A deliberately tiny context window so a modest seeded history overruns the
 * budget and forces the trim strategy. safetyFraction / reserve zeroed so the
 * budget is exactly `contextWindow` — matching the unit-test convention.
 */
const SMALL_CTX = 1_200;
const ORIGINAL_MAX_TOKENS = 16_384;
const COMPACTION = { safetyFraction: 0, responseReserveFloor: 0, responseReserveCap: 0 };

/** Build the same custom mock model the harness uses, with a tiny window. */
function makeMockModel(scriptKey: string): any {
  const base = resolveModelObject(MOCK_PROVIDER, `mock:${scriptKey}`, baseUrl);
  return { ...base, contextWindow: SMALL_CTX, maxTokens: ORIGINAL_MAX_TOKENS };
}

/** Seed N over-long user turns (each ~well above one budget's worth). */
function longHistory(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    role: "user" as const,
    content: `historical turn ${i}: ${"q".repeat(500)}`,
    timestamp: i + 1,
  }));
}

/** Drive the REAL production buildPiAgent path with our mock model. */
function buildRealAgent(piModel: any, history: any[], agentTools: any[] = []) {
  const ctx = { system: "you are a test agent", agentTools } as any;
  const resolvedModel = {
    resolved: { provider: MOCK_PROVIDER, model: piModel.id, piModel },
    initialCred: { type: "apikey", token: "no-key-needed" },
  } as any;
  return buildPiAgent(ctx, history, { compaction: COMPACTION, thinkingLevel: "off" } as any, resolvedModel, "conv-real");
}

/**
 * Flatten a wire message's `content` to plain text. openai-completions
 * serializes string-content messages (seeded history + the injected marker)
 * as a bare string, but a `prompt()`-created user message as an array of
 * `{ type: "text", text }` parts — normalize both.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && (p as any).type === "text" ? String((p as any).text ?? "") : "")).join("");
  }
  return "";
}

function hasMarker(req: RecordedRequest): boolean {
  return req.messages.some((m) => m.role === "user" && contentText(m.content).startsWith(MARKER_PREFIX));
}

function userTexts(req: RecordedRequest): string[] {
  return req.messages.filter((m) => m.role === "user").map((m) => contentText(m.content));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("real pi-agent Agent applies compaction transformContext per LLM call", () => {
  test("the LLM RECEIVES a trimmed context on the wire (hook fired on the real Agent)", async () => {
    const SEEDED = 60;
    const scriptKey = "compaction-single";
    setMockScript(scriptKey, [{ text: "acknowledged", finishReason: "stop" }]);

    const piModel = makeMockModel(scriptKey);
    const finalPrompt = "FINAL_ACTIVE_PROMPT please answer";
    const agent = buildRealAgent(piModel, longHistory(SEEDED));

    // Run a real turn: prompt() → runAgentLoop → streamAssistantResponse →
    // transformContext → convertToLlm → streamSimple (HTTP POST to our server).
    await agent.prompt(finalPrompt);
    await agent.waitForIdle();

    // The real Agent made exactly one real HTTP LLM call.
    expect(recorded.length).toBe(1);
    const req = recorded[0]!;

    // 1. The wire payload was TRIMMED: far fewer messages than the
    //    SEEDED history + 1 active prompt the Agent held in state.
    expect(req.messages.length).toBeLessThan(SEEDED + 1);

    // 2. The trim strategy specifically ran on the REAL context: a
    //    compaction marker is present on the wire.
    expect(hasMarker(req)).toBe(true);

    // 3. The active turn survived — the LLM still sees the current question.
    expect(userTexts(req).some((t) => t.includes("FINAL_ACTIVE_PROMPT"))).toBe(true);

    // 4. The oldest seeded turns were evicted (turn 0 is gone).
    expect(userTexts(req).some((t) => t.startsWith("historical turn 0:"))).toBe(false);

    // INVARIANT (input-only): maxTokens was NOT mutated end-to-end through
    // the full real path (build + transform + loop + wire call).
    expect(piModel.maxTokens).toBe(ORIGINAL_MAX_TOKENS);
    expect((agent.state.model as any).maxTokens).toBe(ORIGINAL_MAX_TOKENS);
    expect((agent.state.model as any).contextWindow).toBe(SMALL_CTX);
  });

  test("the hook fires before EACH LLM call across an agentic tool loop", async () => {
    const SEEDED = 60;
    const scriptKey = "compaction-toolloop";
    // Turn 1: call the noop tool → forces a second LLM call. Turn 2: stop.
    const script: MockTurn[] = [
      { toolCalls: [{ name: "noop", arguments: {} }], finishReason: "tool_calls" },
      { text: "all done", finishReason: "stop" },
    ];
    setMockScript(scriptKey, script);

    const noopTool = {
      name: "noop",
      label: "noop",
      description: "A no-op tool used to force a second LLM call in the agent loop.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    };

    const piModel = makeMockModel(scriptKey);
    const agent = buildRealAgent(piModel, longHistory(SEEDED), [noopTool]);

    await agent.prompt("TOOL_LOOP_PROMPT run the tool then finish");
    await agent.waitForIdle();

    // The loop iterated: two real LLM calls (initial + post-tool-result).
    expect(recorded.length).toBe(2);

    // transformContext fired before BOTH calls — each wire payload is trimmed
    // and carries a compaction marker (a hook-application regression on the
    // 2nd iteration would surface an untrimmed, marker-less payload here).
    for (const req of recorded) {
      expect(req.messages.length).toBeLessThan(SEEDED + 1);
      expect(hasMarker(req)).toBe(true);
    }

    // The 2nd request carries the tool round-trip (assistant toolCall +
    // toolResult) produced by the real loop — proving it is a genuine
    // per-iteration LLM call, not a replay of the first.
    const second = recorded[1]!;
    expect(second.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);

    // INVARIANT holds across the multi-call loop.
    expect(piModel.maxTokens).toBe(ORIGINAL_MAX_TOKENS);
    expect((agent.state.model as any).maxTokens).toBe(ORIGINAL_MAX_TOKENS);
  });

  test("a short history is passed to the LLM untouched (no spurious trimming)", async () => {
    const scriptKey = "compaction-short";
    setMockScript(scriptKey, [{ text: "hi", finishReason: "stop" }]);

    // Large window → short history is under budget → transform is a no-op.
    const piModel = { ...makeMockModel(scriptKey), contextWindow: 400_000 };
    const agent = buildRealAgent(piModel, [{ role: "user", content: "earlier", timestamp: 1 }]);

    await agent.prompt("hello");
    await agent.waitForIdle();

    expect(recorded.length).toBe(1);
    const req = recorded[0]!;
    // Both messages reach the LLM verbatim; no compaction marker injected.
    expect(hasMarker(req)).toBe(false);
    expect(userTexts(req)).toEqual(["earlier", "hello"]);
  });
});
