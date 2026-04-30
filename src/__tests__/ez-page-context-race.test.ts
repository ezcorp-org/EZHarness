/**
 * Phase 48 fix — `<page_context>` vs memory-injection race regression.
 *
 * Bug
 * ────
 * `setupTools` runs three IIFEs inside one `Promise.all`:
 *   (1) memory injection,
 *   (2) tool loading (which previously appended `<page_context>` for Ez
 *       turns inline),
 *   (3) model resolution.
 *
 * The memory branch snapshots `ctx.system` BEFORE its slow
 * `await generateEmbedding(...)` call, then writes
 * `ctx.system = injection.systemPrompt` (built from the snapshot) when
 * the await resolves. Anything else that mutated `ctx.system` during the
 * await is silently clobbered. Branch (2) usually finishes the
 * page-context append while embedding is still pending, so the `ez`
 * persona's `<page_context>` block disappeared whenever a project had
 * memories.
 *
 * Fix
 * ────
 * Move the `<page_context>` append OUT of the `Promise.all` to AFTER it
 * resolves — same deferral the orchestrator-prompt block already uses
 * (see auto-spin-up.ts). The post-Promise.all write happens after
 * memory's snapshot/write-back has fully landed, so the block is
 * preserved unconditionally.
 *
 * What this test asserts
 * ──────────────────────
 * 1. With memory-injection ENABLED (project has memories) AND a slow
 *    embedding generator (forced microtask delay), the final
 *    `ctx.system` contains BOTH the memory block AND the
 *    `<page_context>` block. That is the exact race window where the
 *    pre-fix code lost the page_context.
 *
 * 2. With memory-injection DISABLED (project has no memories or KB), the
 *    `<page_context>` block still lands. Sanity check that we didn't
 *    accidentally couple the two paths.
 *
 * 3. With `convRecord.kind !== 'ez'` the block is NOT injected, even if
 *    `options.ezContext` is set. Defense-in-depth gate is preserved.
 *
 * 4. With circular `options.ezContext` the function does not throw —
 *    the JSON.stringify failure is caught and logged.
 *
 * No real DB, no real model resolution. Every external module
 * `setupTools` reaches via dynamic import is mocked to a deterministic
 * stub at module scope before the function under test is loaded.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Module mocks (must be installed before importing setup-tools) ──────

// Memory injection: mimic the production snapshot/write-back pattern
// exactly. Capture ctx.system at call time, append "##MEM##", and return
// the resulting string. The bug only manifests when this branch holds a
// snapshot across an await — buildSystemPromptWithMemories is what does
// that in production. We don't await inside the mock; the async race is
// produced by `generateEmbedding` below.
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (
    base: string | undefined,
    _userMessage: string,
    _projectId: string,
    _opts: unknown,
  ) => {
    // Same shape the real function returns — the snapshot of ctx.system
    // is `base`, and we hand back base + memory block.
    return {
      systemPrompt: `${base ?? ""}\n\n##MEM##`,
      memoriesUsed: [{ id: "m1", content: "hello", category: "fact" }],
    };
  },
}));

// Slow embedding — yields the event loop several times before resolving
// so any other Promise.all branch that tries to mutate ctx.system gets
// a chance to run BEFORE the memory branch's write-back lands. This is
// the exact timing window the pre-fix code lost `<page_context>` in.
mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => {
    // Two microtask hops + one macrotask = comfortably wider than the
    // tool-loading branch's first `await import(...)` chain, so the
    // pre-fix code would have already written `<page_context>` into
    // ctx.system by the time the memory snapshot/write-back catches up.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    return new Array(8).fill(0.1);
  },
  generateEmbeddings: async (texts: string[]) => texts.map(() => new Array(8).fill(0.1)),
  resetEmbeddingProvider: () => {},
}));

mock.module("../memory/retrieval", () => ({
  searchKBChunksForQuery: async () => [],
  hybridSearch: async () => [],
}));

mock.module("../db/queries/memories", () => ({
  hasMemories: async () => true, // force the embedding path
}));

mock.module("../db/queries/knowledge-base", () => ({
  hasKBChunks: async () => false,
}));

mock.module("../db/queries/projects", () => ({
  // Returning null short-circuits the project-tool branch (no path to
  // resolve = no extension/permission machinery). Setup still runs.
  getProject: async () => null,
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({ provider: "anthropic", model: "claude-stub", piModel: { _stub: true } }),
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => null,
}));

// Mention-wiring + extension-id queries: the tool-loading branch awaits
// these unconditionally. Stub to no-ops so the branch finishes promptly
// without needing a populated DB.
mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
  resolveMentionedAgents: async () => [],
  resolveMentionedTeams: async () => [],
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => [],
  addConversationExtensions: async () => {},
}));

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async () => null,
}));

mock.module("../db/queries/agent-configs", () => ({
  getAgentConfig: async () => null,
  getAgentConfigsByIds: async () => new Map(),
}));

mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => false,
}));

mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => false,
  wireAskUserToolForTurn: async () => {},
}));

// Capture every wireEzToolsForTurn call so we can assert it ran.
const ezWireCalls: unknown[] = [];
mock.module("../runtime/ez-tools-host", () => ({
  wireEzToolsForTurn: (params: unknown) => { ezWireCalls.push(params); },
}));

mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => false,
  wireOrchestrationToolsForTurn: async () => {},
}));

// ── Imports (after mocks) ──────────────────────────────────────────────
const { setupTools } = await import("../runtime/stream-chat/setup-tools");
const { createStreamChatContext } = await import("../runtime/stream-chat/context");
const { EventBus } = await import("../runtime/events");

// Build a minimal StreamChatHost stub. The phase only reads
// `bus`, `pendingPermissions`, `executor`, `stateMediator`, `spawnQuota`,
// and `watchdog` is unused inside setupTools. The fields are typed with
// `as unknown as ...` to bypass full interface coverage — the runtime
// only touches the surface above.
function makeHost() {
  return {
    bus: new EventBus<any>(),
    persist: false,
    pendingPermissions: new Map(),
    controllers: new Map(),
    runConversations: new Map(),
    activeAgents: new Map(),
    runs: new Map(),
    watchdog: { startWatchdog: () => {} } as any,
    stateMediator: undefined,
    spawnQuota: { acquire: () => true, release: () => {} } as any,
    executor: {} as any,
  } as any;
}

function makeRun(): any {
  return {
    id: "run-1",
    agentName: "ez",
    status: "running",
    startedAt: Date.now(),
    logs: [],
  };
}

function makeCtx() {
  const ctx = createStreamChatContext(makeRun(), new AbortController(), undefined);
  // Seed a base system prompt — the persona prompt the migration would
  // have placed there in production. Tests can match against this prefix
  // to make sure it survives both the memory write-back and the
  // post-Promise.all page_context append.
  ctx.system = "EZ_PERSONA_BASE";
  return ctx;
}

describe("setupTools — Ez page_context vs memory-injection race", () => {
  beforeEach(() => {
    ezWireCalls.length = 0;
  });

  // Bun's `mock.module()` is process-global and persists across test
  // files. This file installs ~16 stubs (DB queries, providers, runtime
  // hosts), every one of which would leak into subsequent test files in
  // the suite without a restore. ez-clear-leaks-context.test.ts hits
  // `getConversationExtensionIds` directly and goes red when our
  // no-op stub leaks; restoring snapshots in afterAll closes that gap.
  afterAll(() => restoreModuleMocks());

  test("memory injection + Ez ezContext both land — page_context survives the race", async () => {
    const ctx = makeCtx();
    const host = makeHost();

    const ezContext = {
      route: { url: "/project/p1/chat/c1", routeId: "/(app)/project/[id]/chat/[convId]", conversationId: "c1" },
      data: {},
      formIds: [],
    };

    await setupTools(
      ctx,
      host,
      "conv-1",
      "summarize this conversation",
      { projectId: "p1", ezContext } as any,
      [],
      { kind: "ez", userId: "user-1" },
      "conv-1",
    );

    // Bug repro: pre-fix, ctx.system would equal
    //   "EZ_PERSONA_BASE\n\n##MEM##"
    // — the inline `<page_context>` write inside Promise.all was clobbered
    // by the memory branch's snapshot/write-back. Post-fix BOTH must
    // appear.
    expect(ctx.system).toContain("EZ_PERSONA_BASE");
    expect(ctx.system).toContain("##MEM##");
    expect(ctx.system).toContain("<page_context>");
    expect(ctx.system).toContain("</page_context>");
    // Order invariant: page_context appended AFTER the memory block.
    const memIdx = ctx.system!.indexOf("##MEM##");
    const pageIdx = ctx.system!.indexOf("<page_context>");
    expect(pageIdx).toBeGreaterThan(memIdx);

    // Sanity: the JSON-encoded conversationId is present so the LLM can
    // extract it. This is the contract summarize_conversation depends on.
    expect(ctx.system).toContain('"conversationId":"c1"');

    // Sanity: the Ez tools host was actually invoked (we're in an Ez turn).
    expect(ezWireCalls.length).toBe(1);
  });

  test("no memories + Ez ezContext: page_context still lands (memory branch short-circuits)", async () => {
    // Re-mock hasMemories to false so the embedding path is skipped
    // entirely. The page_context append must still run.
    mock.module("../db/queries/memories", () => ({ hasMemories: async () => false }));
    mock.module("../db/queries/knowledge-base", () => ({ hasKBChunks: async () => false }));

    // Re-import setupTools to pick up the new mocks. Bun's module mock
    // applies on next import; we already have a reference via ESM, so
    // use a cache-busting query string trick is unnecessary — the
    // mock.module override is global per process.
    const ctx = makeCtx();
    const host = makeHost();

    await setupTools(
      ctx,
      host,
      "conv-2",
      "hi",
      { projectId: "p1", ezContext: { route: { conversationId: "c2" } } } as any,
      [],
      { kind: "ez", userId: "user-1" },
      "conv-2",
    );

    expect(ctx.system).toContain("EZ_PERSONA_BASE");
    expect(ctx.system).toContain("<page_context>");
    expect(ctx.system).toContain('"conversationId":"c2"');
  });

  test("non-ez conversation: page_context is NOT injected even if ezContext is supplied", async () => {
    const ctx = makeCtx();
    const host = makeHost();

    await setupTools(
      ctx,
      host,
      "conv-3",
      "hello",
      { projectId: "p1", ezContext: { route: { conversationId: "c3" } } } as any,
      [],
      { kind: "regular", userId: "user-1" } as any,
      "conv-3",
    );

    expect(ctx.system).not.toContain("<page_context>");
    expect(ezWireCalls.length).toBe(0);
  });

  test("circular ezContext: function returns without throwing, page_context omitted", async () => {
    const ctx = makeCtx();
    const host = makeHost();

    const circular: any = { route: { conversationId: "c4" } };
    circular.self = circular; // JSON.stringify will throw

    // The call must not throw — the catch branch logs + drops the block.
    await setupTools(
      ctx,
      host,
      "conv-4",
      "hi",
      { projectId: "p1", ezContext: circular } as any,
      [],
      { kind: "ez", userId: "user-1" },
      "conv-4",
    );

    expect(ctx.system).not.toContain("<page_context>");
    // The other ctx.system mutations (memory injection / base prompt)
    // must still be intact.
    expect(ctx.system).toContain("EZ_PERSONA_BASE");
  });
});
