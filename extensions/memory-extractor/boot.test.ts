// memory-extractor — production-wiring coverage (RPC surface, loop acts, boot).
//
// `index.test.ts` drives the extraction PIPELINE through the
// `_setRuntimeApiForTests` seam, which by construction never executes the real
// `runtimeApi` implementations, either `defineLoop` act callback, or the boot
// body. Those are the extension's contract with the host, so this file covers
// them IN-process — same shape as the sibling
// `extensions/lessons-distiller/boot.test.ts` and the reference
// `docs/extensions/examples/webhook-ticket-loop/boot.test.ts`:
//
//   - `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `./index`
//     replaces `invoke` / `Llm` with recorders, so the REAL `runtimeApi`
//     wrappers run and their host RPC method names + param shapes are
//     asserted (a rename there is a silent production break the seam-swapped
//     suite cannot see).
//   - `defineLoop` is captured via a delegating stub so both acts'
//     outcome→loop-result mappings are invoked directly.
//   - `getChannel` / `createToolDispatcher` are inert spies, so `start()`
//     runs without opening stdin.
//
// `restoreModuleMocks()` in `afterAll` hands the real module back.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "@ezcorp/sdk/test";
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

const ONE_FACT_JSON = JSON.stringify([
  {
    content: "User prefers bun over node",
    category: "preferences",
    confidence: "high",
    messageIds: ["m1"],
  },
]);

let settingsReply: Record<string, unknown>;
let onInvoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
let onLlmComplete: (opts: Record<string, unknown>) => Promise<{ content: string }>;

/** Loop definitions captured from the stubbed `defineLoop`. */
interface CapturedLoopDef {
  id: string;
  trigger: { kind: string; event?: string; cron?: string };
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
  defineLoop: (def: CapturedLoopDef) => {
    capturedDefs.push(def);
  },
  getChannel: getChannelSpy,
  createToolDispatcher: createToolDispatcherSpy,
}));

const extractor = await import("./index");

/** The `run:complete` payload the dispatcher forwards on a successful chat run. */
const CHAT_RUN_PAYLOAD = {
  run: { agentName: "chat", status: "success" },
  conversationId: "conv-1",
};

beforeEach(() => {
  rpc = [];
  capturedDefs = [];
  settingsReply = { enabled: true };
  onInvoke = async (method) => {
    if (method === "runtime.conversations.getMessages") {
      return {
        messages: [{ id: "m1", role: "user", content: "I prefer bun" }],
        projectId: "proj-1",
      };
    }
    if (method === "runtime.memory.dedupMemoryWrite") {
      return { action: "inserted", memoryId: "mem-1" };
    }
    if (method === "runtime.memory.compact") return { mergedCount: 3 };
    // runtime.settings.getMine
    return settingsReply;
  };
  onLlmComplete = async () => ({ content: ONE_FACT_JSON });
});

// ─────────────────────────────────────────────────────────────────────
// The REAL runtimeApi — the host RPC contract.
// ─────────────────────────────────────────────────────────────────────

describe("runtimeApi (production wiring, no seam swap)", () => {
  test("an auto-extract fire drives the host surfaces with the contract params", async () => {
    const outcome = await extractor.extractRunComplete(CHAT_RUN_PAYLOAD, {
      enabled: true,
      provider: "anthropic",
    });

    expect(outcome?.kind).toBe("success");
    // These method names ARE the host contract (src/extensions rpc-handlers).
    // Renaming one breaks production silently — the seam-swapped suite would
    // still pass. `getMessages` runs twice: once in extractRunComplete for the
    // project id, once inside extract() for the message window.
    expect(rpc.map((c) => c.method)).toEqual([
      "runtime.conversations.getMessages",
      "runtime.conversations.getMessages",
      "llm.complete",
      "runtime.memory.dedupMemoryWrite",
    ]);
    expect(rpc[0]!.params).toEqual({ conversationId: "conv-1" });
    expect(rpc[2]!.params).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5-20250514",
      maxTokens: 2048,
      temperature: 0,
    });
    // `selfOnly:false` dedup needs the authoring extension id on every write.
    expect(rpc[3]!.params).toMatchObject({
      content: "User prefers bun over node",
      category: "preferences",
      confidence: "high",
      sourceMessageIds: ["m1"],
      conversationId: "conv-1",
      projectId: "proj-1",
      extensionId: "memory-extractor",
      injectionEligible: true,
    });
  });

  test("a getMessages reply with no projectId defaults to null on the write", async () => {
    onInvoke = async (method) => {
      if (method === "runtime.conversations.getMessages") {
        return { messages: [{ id: "m1", role: "user", content: "I prefer bun" }] };
      }
      if (method === "runtime.memory.dedupMemoryWrite") {
        return { action: "updated", memoryId: "mem-9" };
      }
      return settingsReply;
    };

    const outcome = await extractor.extractRunComplete(CHAT_RUN_PAYLOAD, { enabled: true });

    expect(outcome?.kind).toBe("success");
    expect(rpc.find((c) => c.method === "runtime.memory.dedupMemoryWrite")!.params).toMatchObject({
      projectId: null,
    });
  });

  test("a failed conversation read is swallowed — the fire is skipped, never thrown", async () => {
    // Expected for deleted / unwired conversations; a throw here would
    // surface as a loop failure on every run:complete for a dead row.
    onInvoke = async (method) => {
      if (method === "runtime.conversations.getMessages") throw new Error("conversation gone");
      return settingsReply;
    };

    expect(await extractor.extractRunComplete(CHAT_RUN_PAYLOAD, { enabled: true })).toBeUndefined();
  });

  test("the compaction tick reads settings then calls the host compaction sweep", async () => {
    expect(await extractor.handleCompactionTick()).toEqual({ mergedCount: 3 });
    expect(rpc.map((c) => c.method)).toEqual([
      "runtime.settings.getMine",
      "runtime.memory.compact",
    ]);
    expect(rpc[0]!.params).toEqual({});
    expect(rpc[1]!.params).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────
// The loop acts — outcome → loop-result mapping (TWO loops).
// ─────────────────────────────────────────────────────────────────────

describe("defineMemoryLoops — acts map every outcome to a loop result", () => {
  function loops(): { extract: CapturedLoopDef; compaction: CapturedLoopDef } {
    extractor.defineMemoryLoops("0 */3 * * *");
    expect(capturedDefs.map((d) => d.id)).toEqual(["extract", "compaction"]);
    expect(capturedDefs[0]!.trigger).toEqual({ kind: "event", event: "run:complete" });
    // The cron the caller resolved must be the one registered, or the sweep
    // silently runs on the wrong cadence.
    expect(capturedDefs[1]!.trigger).toEqual({ kind: "cron", cron: "0 */3 * * *" });
    return { extract: capturedDefs[0]!, compaction: capturedDefs[1]! };
  }

  test("extract: a gated fire (no conversationId) → skip: gated", async () => {
    expect(await loops().extract.act({ input: { run: {} }, settings: {} })).toEqual({
      kind: "skip",
      reason: "gated",
    });
  });

  test("extract: a successful extraction → terminal: done, carrying the outcome", async () => {
    const result = await loops().extract.act({
      input: CHAT_RUN_PAYLOAD,
      settings: { enabled: true },
    });
    expect(result).toMatchObject({ kind: "terminal", status: "done" });
    expect((result.outcome as { kind: string }).kind).toBe("success");
  });

  test("extract: an error outcome throws so the loop records the failure", async () => {
    onLlmComplete = async () => {
      throw new Error("upstream 503");
    };

    await expect(
      loops().extract.act({ input: CHAT_RUN_PAYLOAD, settings: { enabled: true } }),
    ).rejects.toThrow("llm_error: upstream 503");
  });

  test("extract: a decline → skip carrying the decline reason", async () => {
    expect(
      await loops().extract.act({
        input: { run: { agentName: "team", status: "success" }, conversationId: "conv-1" },
        settings: { enabled: true },
      }),
    ).toEqual({ kind: "skip", reason: "wrong_agent_or_status" });
  });

  test("compaction: a completed sweep → terminal: done with the merge count", async () => {
    expect(await loops().compaction.act({ input: {}, settings: {} })).toEqual({
      kind: "terminal",
      status: "done",
      outcome: { mergedCount: 3 },
    });
  });

  test("compaction: a disabled sweep → skip carrying the skip reason", async () => {
    settingsReply = { enabled: true, compaction_enabled: false };

    expect(await loops().compaction.act({ input: {}, settings: {} })).toEqual({
      kind: "skip",
      reason: "settings_disabled",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveBootCron — the cadence must always resolve to SOMETHING.
// ─────────────────────────────────────────────────────────────────────

describe("resolveBootCron", () => {
  test("a supported setting resolves to its cron", async () => {
    settingsReply = { compaction_interval_hours: "12" };
    expect(await extractor.resolveBootCron()).toBe("0 */12 * * *");
  });

  test("an unsupported setting falls back to the default 6h cron", async () => {
    // The SDK silently DROPS a Schedule.on() for a cron the manifest doesn't
    // declare, so an unrecognised value must fall back rather than register
    // nothing — otherwise compaction never runs at all.
    settingsReply = { compaction_interval_hours: "99" };
    expect(await extractor.resolveBootCron()).toBe(extractor.DEFAULT_COMPACTION_CRON);
  });

  test("unreadable settings fall back to the default 6h cron", async () => {
    onInvoke = async () => {
      throw new Error("settings unavailable at boot");
    };
    expect(await extractor.resolveBootCron()).toBe(extractor.DEFAULT_COMPACTION_CRON);
  });
});

// ─────────────────────────────────────────────────────────────────────
// start() — the production boot body.
// ─────────────────────────────────────────────────────────────────────

describe("start — production boot", () => {
  test("registers both loops on the resolved cron, mounts the dispatcher, starts the channel", async () => {
    const before = channelStarted;
    settingsReply = { compaction_interval_hours: "1" };

    await extractor.start();

    expect(capturedDefs.map((d) => d.id)).toEqual(["extract", "compaction"]);
    // The setting-derived cadence must reach the registration.
    expect(capturedDefs[1]!.trigger).toEqual({ kind: "cron", cron: "0 */1 * * *" });
    // This extension declares no manual tools, but the tools/call plumbing
    // must still be mounted or the host's dispatch handshake fails.
    expect(dispatcherToolsArg).toEqual({});
    expect(channelStarted).toBe(before + 1);
  });
});
