/**
 * End-to-end test for the `ask-user` bundled extension. Wires the REAL
 * pieces together to prove the full lifecycle works:
 *
 *   - Real subprocess running `docs/extensions/examples/ask-user/index.ts`.
 *   - Real `src/runtime/ask-user-host.ts` helpers
 *     (`ensureAskUserWired` + `wireAskUserToolForTurn`) which thread
 *     `invocationMetadata: { conversationId }` to the wrapper.
 *   - Real `extensionToAgentTool` per-call seam — the host-minted
 *     `toolCallId` flows into `ctx.invocationMetadata.toolCallId` via
 *     the widening committed alongside this extension.
 *   - Real `EventSubscriptionDispatcher` — delivers `ask-user:answer`
 *     back to the extension subprocess.
 *   - Real `ask-user-registry` populated by the wire wrapper — the
 *     simulated POST reads from it to resolve `toolCallId →
 *     conversationId + userId` without hitting the `tool_calls` DB
 *     row (which doesn't exist while the gate is open — see
 *     `src/runtime/ask-user-registry.ts` for the rationale).
 *
 * Test cases:
 *   1. Sentinel: `ask_user_question` appears in `agentTools` after
 *      `wireAskUserToolForTurn` runs.
 *   2. Happy path with options: registry populated by wire wrapper →
 *      simulated POST → bus emit → subscription delivery → tool
 *      result equals option.
 *   3. Happy path free-text: same flow without options.
 *   4. POST endpoint with unknown `toolCallId` returns
 *      `{ ok: true, emitted: false }` — registry empty, gate stays
 *      open. Verified by the bus seeing no event.
 *   5. POST endpoint with conversation NOT owned by the acting user
 *      returns 404 — auth boundary preserved (registry seeded
 *      directly to exercise the mismatch path).
 *   6. Subscription-level guard: a forged `ask-user:answer` with a
 *      mismatched conversationId is dropped silently by the
 *      extension's `handleAnswer`.
 *   7. Concurrent calls across two conversations resolve
 *      independently.
 *   8. Missing `toolCallId` in invocationMetadata → handler returns
 *      error tool-result, no gate opened.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const {
  ensureAskUserWired,
  wireAskUserToolForTurn,
  _resetAskUserExtensionIdCache,
} = await import("../runtime/ask-user-host");
const { EventBus } = await import("../runtime/events");
const { EventSubscriptionDispatcher } = await import(
  "../extensions/event-subscription-dispatcher"
);
const { getDb } = await import("../db/connection");
const {
  conversations,
  extensions: extensionsTable,
  projects,
  users,
} = await import("../db/schema");
const {
  getPendingAskUser,
  registerPendingAskUser,
  _resetPendingAskUserForTests,
} = await import("../runtime/ask-user-registry");
// Phase 1 fail-closed: wireAskUserToolForTurn calls getPermissionEngine()
// without deps; the singleton must be pre-initialized before any test
// runs. Install an allow-all stub so the wrapped tool's authorize()
// always passes — the test asserts the registry / bus / subscription
// behavior, not the PDP semantics.
const { _setPermissionEngineForTests, _resetPermissionEngineForTests } = await import(
  "../extensions/permission-engine"
);
const { createStubPermissionEngine } = await import(
  "./helpers/permission-engine-stub"
);

import type { AgentEvents } from "../types";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { RegisteredTool } from "../extensions/registry";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "ask-user",
  "index.ts",
);

const EXT_ID = "ext-ask-user-e2e";
const CONV_ID = "conv-ask-user-e2e";
const CONV_ID_B = "conv-ask-user-e2e-b";
const PROJ_ID = "proj-ask-user-e2e";
const USER_ID = "user-ask-user-e2e";
const OTHER_USER_ID = "user-other-e2e";

// ── Subprocess harness ──────────────────────────────────────────────

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  waitAfter: (
    i: number,
    pred: (m: Record<string, unknown>) => boolean,
    ms?: number,
  ) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  }) as Subprocess<"pipe", "pipe", "pipe">;

  const outbound: Record<string, unknown>[] = [];
  let buffer = "";

  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            outbound.push(JSON.parse(line));
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* */
    }
  })();

  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      /* */
    }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
  }

  async function waitAfter(
    i: number,
    pred: (m: Record<string, unknown>) => boolean,
    ms = 5000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (let k = i; k < outbound.length; k++) {
        const m = outbound[k]!;
        if (pred(m)) return m;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitAfter(${i}) timed out`);
  }

  function kill(): void {
    try {
      proc.kill();
    } catch {
      /* */
    }
  }
  return { proc, outbound, inbound, waitAfter, kill };
}

// ── Manifest + permission fixtures ─────────────────────────────────

const GRANTED: ExtensionPermissions = {
  eventSubscriptions: ["ask-user:answer"],
  grantedAt: { eventSubscriptions: Date.now() },
};

const MANIFEST: ExtensionManifestV2 = {
  schemaVersion: 2,
  name: "ask-user",
  version: "1.0.0",
  description: "ask-user e2e",
  author: { name: "test" },
  permissions: { eventSubscriptions: ["ask-user:answer"] },
};

// ── Fake registry — exposes ask_user_question ──────────────────────

interface FakeRegistry {
  getToolsForExtension: (extId: string) => RegisteredTool[];
  getRegisteredTool: (name: string) => RegisteredTool | undefined;
  getProcess: (extId: string) => Promise<{
    isRunning: boolean;
    callTool: (
      name: string,
      args: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ) => Promise<unknown>;
    setNotificationHandler: (fn: (n: unknown) => void) => void;
    setRequestHandler: (fn: (req: Record<string, unknown>) => Promise<Record<string, unknown>>) => void;
  }>;
  getManifest: (extId: string) => ExtensionManifestV2 | undefined;
  getGrantedPermissions: (extId: string) => ExtensionPermissions | undefined;
  getInstallPath: (extId: string) => string | undefined;
  getMcpClient: () => never;
}

function makeFakeRegistry(p: TestProc): FakeRegistry {
  let nextCallId = 5_000_000;
  const askTool: RegisteredTool = {
    name: "ask_user_question",
    originalName: "ask_user_question",
    description:
      "Ask the user a question and wait for their answer. Use options when finite.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["question"],
    },
    extensionId: EXT_ID,
    extensionName: "ask-user",
  } as RegisteredTool;

  const procWrapper = {
    isRunning: true,
    setNotificationHandler: () => {},
    setRequestHandler: () => {},
    async callTool(
      name: string,
      args: Record<string, unknown>,
      meta?: Record<string, unknown>,
    ) {
      const id = ++nextCallId;
      const cursor = p.outbound.length;
      p.inbound({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          ...(meta !== undefined ? { _meta: meta } : {}),
        },
      });
      const resp = await p.waitAfter(
        cursor,
        (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
      );
      if (resp.error) {
        return {
          content: [{ type: "text", text: JSON.stringify(resp.error) }],
          isError: true,
        };
      }
      return resp.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
        details?: unknown;
      };
    },
  };

  return {
    getToolsForExtension: (extId: string) => (extId === EXT_ID ? [askTool] : []),
    getRegisteredTool: (name: string) =>
      name === "ask_user_question" ? askTool : undefined,
    getProcess: async (extId: string) => {
      if (extId !== EXT_ID) throw new Error(`unknown extension: ${extId}`);
      return procWrapper;
    },
    getManifest: (extId: string) => (extId === EXT_ID ? MANIFEST : undefined),
    getGrantedPermissions: (extId: string) =>
      extId === EXT_ID ? GRANTED : undefined,
    getInstallPath: (extId: string) => (extId === EXT_ID ? "/tmp/ask-user-e2e" : undefined),
    getMcpClient: () => {
      throw new Error("not an MCP extension");
    },
  };
}

// ── Dispatcher stub-registry ───────────────────────────────────────

function makeStubRegistryForDispatcher(p: TestProc) {
  const wrapped = {
    isRunning: true,
    sendNotification(method: string, params?: Record<string, unknown>): void {
      p.inbound({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },
  };
  return {
    getProcessIfRunning: (id: string) => (id === EXT_ID ? wrapped : null),
    getManifest: () => MANIFEST,
    getGrantedPermissions: () => GRANTED,
  };
}

// ── Simulated POST `/api/ask-user/answer` ──────────────────────────
//
// Replicates the real endpoint's logic so the e2e test exercises the
// production resolution path. Looks up the registry populated by the
// `wireAskUserToolForTurn` execute wrapper (in-memory map keyed on
// toolCallId, set BEFORE subprocess dispatch and cleared on
// completion). Mismatched user → 404, no entry → no-op.

interface PostResult {
  emitted: boolean;
  status: "ok" | "not-found";
}

function simulatePostAnswer(
  bus: InstanceType<typeof EventBus<AgentEvents>>,
  toolCallId: string,
  answer: string,
  actingUserId: string,
): PostResult {
  const pending = getPendingAskUser(toolCallId);
  if (!pending) return { emitted: false, status: "ok" };
  if (pending.userId !== actingUserId) return { emitted: false, status: "not-found" };
  bus.emit("ask-user:answer", {
    toolCallId,
    conversationId: pending.conversationId,
    answer,
  });
  return { emitted: true, status: "ok" };
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(users)
    .values({
      id: USER_ID,
      email: "ask-user-e2e@t.local",
      passwordHash: "x",
      name: "AskUserE2E",
    } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(users)
    .values({
      id: OTHER_USER_ID,
      email: "other-e2e@t.local",
      passwordHash: "x",
      name: "OtherE2E",
    } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(projects)
    .values({ id: PROJ_ID, name: PROJ_ID, path: "/tmp/" + PROJ_ID } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({
      id: CONV_ID,
      projectId: PROJ_ID,
      title: "ask-user-e2e-conv",
      userId: USER_ID,
    } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(conversations)
    .values({
      id: CONV_ID_B,
      projectId: PROJ_ID,
      title: "ask-user-e2e-conv-B",
      userId: USER_ID,
    } as never)
    .onConflictDoNothing();
  await getDb()
    .insert(extensionsTable)
    .values({
      id: EXT_ID,
      name: "ask-user",
      version: "1.0.0",
      description: "ask-user e2e",
      manifest: MANIFEST,
      source: `test:${EXT_ID}`,
      installPath: `/tmp/${EXT_ID}`,
      enabled: true,
      grantedPermissions: GRANTED,
    } as never)
    .onConflictDoNothing();
  await ensureAskUserWired(CONV_ID);
  await ensureAskUserWired(CONV_ID_B);
  // Install allow-all PDP stub for wireAskUserToolForTurn's bare
  // getPermissionEngine() call (Phase 1 fail-closed contract).
  _resetPermissionEngineForTests();
  _setPermissionEngineForTests(createStubPermissionEngine("allow-all"));
});

afterAll(async () => {
  _resetPermissionEngineForTests();
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  _resetAskUserExtensionIdCache();
  _resetPendingAskUserForTests();
});

// ── Helpers ─────────────────────────────────────────────────────────

async function wireTools(
  proc: TestProc,
  conversationId: string,
  runId: string,
): Promise<AgentTool[]> {
  const agentTools: AgentTool[] = [];
  await wireAskUserToolForTurn({
    agentTools,
    conversationId,
    runId,
    registry: makeFakeRegistry(proc) as never,
    userId: USER_ID,
  });
  return agentTools;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ask-user e2e: wire → tool call → simulated POST → bus emit → subscription → tool result", () => {
  test("sentinel: ask_user_question appears in agentTools after wireAskUserToolForTurn", async () => {
    const proc = spawnExtension();
    try {
      const agentTools = await wireTools(proc, CONV_ID, "run-sentinel");
      expect(agentTools.map((t) => t.name)).toContain("ask_user_question");
      expect(agentTools).toHaveLength(1);
    } finally {
      proc.kill();
    }
  });

  test("happy path with options — tool returns chosen option text", async () => {
    const proc = spawnExtension();
    const bus = new EventBus<AgentEvents>();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as never,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["ask-user:answer"]);
    dispatcher.start();

    try {
      const agentTools = await wireTools(proc, CONV_ID, "run-happy");
      const ask = agentTools.find((t) => t.name === "ask_user_question")!;
      expect(ask).toBeDefined();

      const toolCallId = "tc-e2e-happy-1";
      // Registry is populated automatically by the wire wrapper when
      // execute() runs; no explicit pre-insert needed.

      const execPromise = ask.execute(toolCallId, {
        question: "Pick one",
        options: ["A", "B", "C"],
      });

      // Allow the handler to register the gate.
      await new Promise((r) => setTimeout(r, 50));

      const post = simulatePostAnswer(bus, toolCallId, "B", USER_ID);
      expect(post.emitted).toBe(true);

      const result = await execPromise;
      expect(result.details?.isError).toBeFalsy();
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("B");
    } finally {
      dispatcher.stop();
      proc.kill();
    }
  });

  test("happy path free-text — tool returns typed answer verbatim", async () => {
    const proc = spawnExtension();
    const bus = new EventBus<AgentEvents>();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as never,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["ask-user:answer"]);
    dispatcher.start();

    try {
      const agentTools = await wireTools(proc, CONV_ID, "run-text");
      const ask = agentTools.find((t) => t.name === "ask_user_question")!;
      const toolCallId = "tc-e2e-text-1";
      

      const execPromise = ask.execute(toolCallId, { question: "What's your name?" });
      await new Promise((r) => setTimeout(r, 50));

      const post = simulatePostAnswer(bus, toolCallId, "Alice", USER_ID);
      expect(post.emitted).toBe(true);

      const result = await execPromise;
      const text = (result.content[0] as { text: string }).text;
      expect(text).toBe("Alice");
    } finally {
      dispatcher.stop();
      proc.kill();
    }
  });

  test("POST with unknown toolCallId — endpoint short-circuits, no emit", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: unknown[] = [];
    bus.on("ask-user:answer" as never, ((p: unknown) => events.push(p)) as never);

    const post = simulatePostAnswer(
      bus,
      "tc-DOES-NOT-EXIST",
      "stale",
      USER_ID,
    );
    expect(post.status).toBe("ok");
    expect(post.emitted).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("POST by a different user — endpoint returns 404, no emit", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: unknown[] = [];
    bus.on("ask-user:answer" as never, ((p: unknown) => events.push(p)) as never);

    const toolCallId = "tc-e2e-auth-1";
    // Seed the registry as if a USER_ID-owned conversation has the gate
    // open. The POST then arrives from OTHER_USER_ID — the owner check
    // must reject with 404 (not-found, not 403, to avoid leaking
    // existence of others' tool calls).
    registerPendingAskUser(toolCallId, CONV_ID, USER_ID);

    const post = simulatePostAnswer(bus, toolCallId, "intruder", OTHER_USER_ID);
    expect(post.status).toBe("not-found");
    expect(post.emitted).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("subscription-level guard: forged ask-user:answer with wrong conversationId is dropped silently", async () => {
    const proc = spawnExtension();
    const bus = new EventBus<AgentEvents>();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as never,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["ask-user:answer"]);
    dispatcher.start();

    try {
      const agentTools = await wireTools(proc, CONV_ID, "run-guard");
      const ask = agentTools.find((t) => t.name === "ask_user_question")!;
      const toolCallId = "tc-e2e-guard-1";
      

      const execPromise = ask.execute(toolCallId, { question: "guard test" });
      await new Promise((r) => setTimeout(r, 50));

      // Forge an event directly on the bus with a mismatched conversationId.
      // The dispatcher will fan it out (per-conversation gating happens at
      // the dispatcher's resolver — here we use `async () => [EXT_ID]`
      // which always returns this extension as wired). The extension's
      // own handleAnswer drops it via the security double-check.
      bus.emit("ask-user:answer", {
        toolCallId,
        conversationId: "conv-ATTACKER",
        answer: "tampered",
      });

      const sentinel = new Promise<"sentinel">((r) =>
        setTimeout(() => r("sentinel"), 300),
      );
      const toolResolve = execPromise.then(() => "resolved" as const);
      const winner = await Promise.race([sentinel, toolResolve]);
      expect(winner).toBe("sentinel");

      // Send the matching answer — gate must still be alive.
      const post = simulatePostAnswer(bus, toolCallId, "rightful", USER_ID);
      expect(post.emitted).toBe(true);

      const result = await execPromise;
      expect((result.content[0] as { text: string }).text).toBe("rightful");
    } finally {
      dispatcher.stop();
      proc.kill();
    }
  });

  test("concurrent ask_user_question across two conversations resolve independently", async () => {
    const procA = spawnExtension();
    const procB = spawnExtension();
    const bus = new EventBus<AgentEvents>();
    const dispatcherA = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(procA) as never,
      async (cid: string) => (cid === CONV_ID ? [EXT_ID] : []),
    );
    const dispatcherB = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(procB) as never,
      async (cid: string) => (cid === CONV_ID_B ? [EXT_ID] : []),
    );
    dispatcherA.registerExtension(EXT_ID, ["ask-user:answer"]);
    dispatcherB.registerExtension(EXT_ID, ["ask-user:answer"]);
    dispatcherA.start();
    dispatcherB.start();

    try {
      const toolsA = await wireTools(procA, CONV_ID, "run-conc-A");
      const toolsB = await wireTools(procB, CONV_ID_B, "run-conc-B");
      const askA = toolsA.find((t) => t.name === "ask_user_question")!;
      const askB = toolsB.find((t) => t.name === "ask_user_question")!;

      const toolCallIdA = "tc-conc-A";
      const toolCallIdB = "tc-conc-B";
      
      

      const execA = askA.execute(toolCallIdA, { question: "A?" });
      const execB = askB.execute(toolCallIdB, { question: "B?" });
      await new Promise((r) => setTimeout(r, 50));

      // Resolve in reverse order — each must only reach its own extension.
      const postB = simulatePostAnswer(bus, toolCallIdB, "answer-B", USER_ID);
      const postA = simulatePostAnswer(bus, toolCallIdA, "answer-A", USER_ID);
      expect(postA.emitted).toBe(true);
      expect(postB.emitted).toBe(true);

      const [resultA, resultB] = await Promise.all([execA, execB]);
      expect((resultA.content[0] as { text: string }).text).toBe("answer-A");
      expect((resultB.content[0] as { text: string }).text).toBe("answer-B");
    } finally {
      dispatcherA.stop();
      dispatcherB.stop();
      procA.kill();
      procB.kill();
    }
  });

  test("missing toolCallId in invocationMetadata → handler returns error", async () => {
    // Drive a tools/call WITHOUT invocationMetadata to exercise the
    // extension's context guard. Bypasses the host wrapper so we can
    // omit the field intentionally.
    const proc = spawnExtension();
    try {
      const cursor = proc.outbound.length;
      proc.inbound({
        jsonrpc: "2.0",
        id: 9999,
        method: "tools/call",
        params: {
          name: "ask_user_question",
          arguments: { question: "no-context?" },
          // _meta omitted on purpose.
        },
      });
      const resp = await proc.waitAfter(
        cursor,
        (m) => m.id === 9999 && (m.result !== undefined || m.error !== undefined),
        3000,
      );
      const result = resp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/missing tool-call context/i);
    } finally {
      proc.kill();
    }
  });
});
