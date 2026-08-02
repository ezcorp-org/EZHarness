// lessons-distiller — production-wiring coverage (RPC surface, loop act, boot).
//
// `index.test.ts` drives the distillation PIPELINE through the
// `_setRuntimeApiForTests` seam, which by construction never executes the real
// `runtimeApi` implementations, the `defineLoop` act callback, or the boot
// body. Those three are the extension's contract with the host, so this file
// covers them IN-process:
//
//   - `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `./index`
//     replaces `invoke` / `Llm` / `Lessons` with recorders, so the REAL
//     `runtimeApi` wrappers run and their host RPC method names + param
//     shapes are asserted (a rename there is a silent production break that
//     no seam-swapped test can see).
//   - `defineLoop` is captured via the same delegating stub used by
//     `docs/extensions/examples/webhook-ticket-loop/boot.test.ts`, so the
//     `act` callback's outcome→loop-result mapping is invoked directly.
//   - `getChannel` / `createToolDispatcher` are inert spies, so `start()`
//     runs without opening stdin.
//
// `restoreModuleMocks()` in `afterAll` hands the real module back.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../src/__tests__/helpers/mock-cleanup";
import * as realRuntime from "@ezcorp/sdk/runtime";

afterAll(() => {
  restoreModuleMocks();
});

// ── Programmable host responses + a recorder for the RPC traffic ────
interface RpcCall {
  method: string;
  params: unknown;
}
let rpc: RpcCall[] = [];

interface LessonRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  visibility: string;
  frontmatter: Record<string, unknown> | null;
}

const VALID_LESSON_JSON = JSON.stringify({
  slug: "prefer-bun-over-node",
  title: "Prefer bun",
  body: "Use bun.",
  frontmatter: { confidence: "high" },
});

const WRITTEN_ROW: LessonRow = {
  id: "les-1",
  slug: "prefer-bun-over-node",
  title: "Prefer bun",
  body: "Use bun.",
  visibility: "user",
  frontmatter: { confidence: "high" },
};

let onInvoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
let onLlmComplete: (opts: Record<string, unknown>) => Promise<{ content: string }>;
let onLessonsWrite: (
  input: Record<string, unknown>,
) => Promise<{ lesson: LessonRow | null; created: boolean }>;

/** Loop definitions captured from the stubbed `defineLoop`. */
interface CapturedLoopDef {
  id: string;
  trigger: { kind: string; event?: string };
  act: (ctx: {
    input: { run?: unknown; conversationId?: string };
    settings: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
}
let capturedDefs: CapturedLoopDef[] = [];

let channelStarted = 0;
const fakeChannel = {
  start() {
    channelStarted++;
  },
};
const getChannelSpy = mock(() => fakeChannel);

let dispatcherToolsArg: Record<string, unknown> | null = null;
const createToolDispatcherSpy = mock((t: Record<string, unknown>) => {
  dispatcherToolsArg = t;
  return { tools: t };
});

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realRuntime,
  invoke: (method: string, params: Record<string, unknown>) => {
    rpc.push({ method, params });
    return onInvoke(method, params);
  },
  Llm: class FakeLlm {
    complete(opts: Record<string, unknown>) {
      rpc.push({ method: "llm.complete", params: opts });
      return onLlmComplete(opts);
    }
  },
  Lessons: class FakeLessons {
    write(input: Record<string, unknown>) {
      rpc.push({ method: "lessons.write", params: input });
      return onLessonsWrite(input);
    }
  },
  defineLoop: (def: CapturedLoopDef) => {
    capturedDefs.push(def);
  },
  getChannel: getChannelSpy,
  createToolDispatcher: createToolDispatcherSpy,
}));

const distiller = await import("./index");

/** The `run:complete` payload the dispatcher forwards on a successful chat run. */
const CHAT_RUN_PAYLOAD = {
  run: { agentName: "chat", status: "success", id: "run-1", startedAt: 1_700_000_000_000 },
  conversationId: "conv-1",
};

beforeEach(() => {
  rpc = [];
  capturedDefs = [];
  distiller._resetDistillerModelWarningForTests();
  onInvoke = async (method) => {
    if (method === "runtime.conversations.getMessages") {
      return {
        messages: [{ id: "m1", role: "user", content: "hello" }],
        projectId: "proj-1",
      };
    }
    // runtime.lessons.triggerGate
    return { shouldDistill: true };
  };
  onLlmComplete = async () => ({ content: VALID_LESSON_JSON });
  onLessonsWrite = async () => ({ lesson: WRITTEN_ROW, created: true });
});

// ─────────────────────────────────────────────────────────────────────
// The REAL runtimeApi — the host RPC contract.
// ─────────────────────────────────────────────────────────────────────

describe("runtimeApi (production wiring, no seam swap)", () => {
  test("an auto-distill fire drives all four host surfaces, in order, with the contract params", async () => {
    const outcome = await distiller.distillRunComplete(CHAT_RUN_PAYLOAD, { provider: "openai" });

    expect(outcome).toEqual({ kind: "success", lesson: WRITTEN_ROW });
    // These four method names ARE the host contract (src/extensions
    // rpc-handlers + the SDK's lessons/llm surfaces). Renaming one breaks
    // production silently — the seam-swapped suite would still pass.
    expect(rpc.map((c) => c.method)).toEqual([
      "runtime.conversations.getMessages",
      "runtime.lessons.triggerGate",
      "llm.complete",
      "lessons.write",
    ]);
    expect(rpc[0]!.params).toEqual({ conversationId: "conv-1" });
    // The run scope must ride along, or the gate re-scores the whole
    // conversation and re-fires on every later turn.
    expect(rpc[1]!.params).toEqual({
      conversationId: "conv-1",
      runId: "run-1",
      runStartedAtMs: 1_700_000_000_000,
    });
    expect(rpc[2]!.params).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      maxTokens: 1024,
      temperature: 0,
    });
    expect(rpc[3]!.params).toMatchObject({
      slug: "prefer-bun-over-node",
      projectId: "proj-1",
      visibility: "user",
      frontmatter: { confidence: "high" },
    });
  });

  test("a getMessages reply with no projectId defaults to null → the fire is skipped", async () => {
    onInvoke = async (method) => {
      if (method === "runtime.conversations.getMessages") {
        return { messages: [{ id: "m1", role: "user", content: "hello" }] };
      }
      return { shouldDistill: true };
    };

    expect(await distiller.distillRunComplete(CHAT_RUN_PAYLOAD, {})).toBeUndefined();
    // No project id → nothing billable ran.
    expect(rpc.map((c) => c.method)).toEqual(["runtime.conversations.getMessages"]);
  });

  test("lessons.write returning no row maps to lesson:null and declines with the parsed slug", async () => {
    onLessonsWrite = async () => ({ lesson: null, created: false });

    expect(await distiller.distillRunComplete(CHAT_RUN_PAYLOAD, {})).toEqual({
      kind: "decline",
      reason: "slug_collision",
      existingSlug: "prefer-bun-over-node",
    });
  });

  test("a JSON-escaped EMPTY sentinel still declines as llm_empty", async () => {
    // A chatty model can emit `"EMPTY"` — valid JSON that PARSES to
    // "EMPTY" but is not byte-equal to the literal `"EMPTY"` the pre-parse
    // fast path checks. Only the post-parse sentinel check catches it.
    onLlmComplete = async () => ({ content: '"\\u0045MPTY"' });

    expect(await distiller.distillRunComplete(CHAT_RUN_PAYLOAD, {})).toEqual({
      kind: "decline",
      reason: "llm_empty",
    });
    // Declined before the write — no lesson row was created.
    expect(rpc.map((c) => c.method)).not.toContain("lessons.write");
  });
});

// ─────────────────────────────────────────────────────────────────────
// The loop `act` — outcome → loop-result mapping.
// ─────────────────────────────────────────────────────────────────────

describe("defineDistillLoop — act maps every outcome to a loop result", () => {
  function act(): CapturedLoopDef["act"] {
    distiller.defineDistillLoop();
    const def = capturedDefs[0];
    expect(def).toBeDefined();
    expect(def!.id).toBe("distill");
    expect(def!.trigger).toEqual({ kind: "event", event: "run:complete" });
    return def!.act;
  }

  test("a gated fire (no conversationId) → skip: gated", async () => {
    expect(await act()({ input: { run: {} }, settings: {} })).toEqual({
      kind: "skip",
      reason: "gated",
    });
  });

  test("a successful distillation → terminal: done, carrying the outcome", async () => {
    expect(await act()({ input: CHAT_RUN_PAYLOAD, settings: {} })).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { kind: "success", lesson: WRITTEN_ROW },
    });
  });

  test("an unavailable model → skip: model_unavailable (never a throw)", async () => {
    // A credential-class failure repeats identically on every run until an
    // operator configures one; throwing would make the loop record a
    // failure + retry forever.
    onLlmComplete = async () => {
      throw new realRuntime.LlmCredentialError("google");
    };

    expect(await act()({ input: CHAT_RUN_PAYLOAD, settings: {} })).toEqual({
      kind: "skip",
      reason: "model_unavailable",
    });
  });

  test("a transient error throws so the loop records the failure", async () => {
    onLessonsWrite = async () => {
      throw new Error("connection reset");
    };

    await expect(act()({ input: CHAT_RUN_PAYLOAD, settings: {} })).rejects.toThrow(
      "db_error: connection reset",
    );
  });

  test("a decline → skip carrying the decline reason", async () => {
    onInvoke = async (method) => {
      if (method === "runtime.conversations.getMessages") {
        return {
          messages: [{ id: "m1", role: "user", content: "hello" }],
          projectId: "proj-1",
        };
      }
      return { shouldDistill: false };
    };

    expect(await act()({ input: CHAT_RUN_PAYLOAD, settings: {} })).toEqual({
      kind: "skip",
      reason: "trigger_gate_blocked",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// start() — the production boot body.
// ─────────────────────────────────────────────────────────────────────

describe("start — production boot", () => {
  test("registers the loop, mounts distill_now on the dispatcher, then starts the channel", () => {
    const before = channelStarted;

    distiller.start();

    expect(capturedDefs.map((d) => d.id)).toEqual(["distill"]);
    // `distill_now` stays hand-written (it returns the DistillerEnvelope the
    // /api/ez-actions forwarder parses), so it must survive the merge with
    // the loop's generated tools.
    expect(dispatcherToolsArg).toHaveProperty("distill_now");
    expect(dispatcherToolsArg!.distill_now).toBe(distiller.tools.distill_now);
    expect(channelStarted).toBe(before + 1);
  });
});
