/**
 * Phase 53.6 — real-process regression test for the boot-spawn chain.
 *
 * The two pre-existing tests that exercise
 * `bootSpawnFlaggedBundledExtensions`
 * (`bundled-extensions-boot-spawn.test.ts`,
 * `run-complete-dispatch.test.ts`) both stub the registry to return an
 * `ExtensionProcess` literal with `isRunning: true` hard-coded — so
 * neither caught the production bug where the helper never invoked
 * `proc.ensureRunning()` and the subprocess therefore never spawned.
 *
 * This test exercises the REAL chain end-to-end:
 *
 *   1. Construct a real `ExtensionRegistry` with our test fixture
 *      manifest + entrypoint registered via the test seams
 *      (`setManifestForTest`, `setInstallPathForTest`,
 *      `setGrantedPermsForTest`). The fixture is event-only with
 *      `persistent: true` — the same shape as lessons-distiller and
 *      memory-extractor after Phase 53.6.
 *   2. Mock the `getExtensionByName` DB query to return a row for
 *      `lessons-distiller` (the bundled name the helper iterates over;
 *      we hijack the slot to point at our fixture manifest in the
 *      registry).
 *   3. Invoke `bootSpawnFlaggedBundledExtensions` with a real
 *      `setNotificationHandler`-installing `wireRpc` callback that
 *      captures incoming notifications from the subprocess.
 *   4. Assert `registry.getProcessIfRunning(extId)` returns a non-null
 *      process AND `proc.isRunning === true` — proves
 *      `ensureRunning` actually fired.
 *   5. Emit a synthetic `run:complete` through a real
 *      `EventSubscriptionDispatcher` wired to the registry; assert
 *      the subprocess receives `ezcorp/event/run:complete` AND echoes
 *      back a `test/received` notification carrying the original
 *      conversationId.
 *
 * Steps 4 + 5 together prove the full chain that the existing tests'
 * `isRunning: true` stubs bypass.
 *
 * Fixture: `fixtures/event-only-extension/` (entrypoint reads stdin
 * line-delimited JSON, echoes a `test/received` notification on
 * `ezcorp/event/run:complete`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { JsonRpcNotification } from "../extensions/types";

const FIXTURE_DIR = resolve(__dirname, "fixtures/event-only-extension");
const FIXTURE_ENTRYPOINT = "./entrypoint.ts";
// Phase 53.7 — second fixture that ALSO performs a reverse-RPC back
// into the host on `run:complete`. Used by the gate round-trip test.
const RPC_FIXTURE_DIR = resolve(__dirname, "fixtures/event-driven-rpc-extension");
// The bundled-extensions list is hardcoded; we hijack the
// `lessons-distiller` slot (bootSpawn: true, no disable flag) by
// pointing its registry entry at our fixture. The DB-row id is
// arbitrary — pick a recognisable string so log lines are debuggable.
const HIJACK_NAME = "lessons-distiller";
const EXT_ID = "ext-real-process-fixture";

// ── DB mock — extensions, conversations, conversation_extensions ────
//
// memory-extractor (the OTHER `bootSpawn: true` bundled entry) has no
// row, so the helper logs "row missing" and skips it. That keeps the
// test focused on a single subprocess and avoids spawning two real
// `bun` children for one assertion.
//
// The reverse-RPC test (Phase 53.7) additionally needs:
//   - `getConversationExtensionIds` to return EXT_ID for the test
//     conversation so the `eventDriven` wiring fallback in
//     `checkConversationGate` succeeds.
//   - `getConversation` + `getMessages` to return real-ish rows so the
//     RPC handler has data to echo back.

interface StoredExtension {
  id: string;
  name: string;
  enabled: boolean;
}

let store: Map<string, StoredExtension>;
let conversationStore: Map<string, { id: string; projectId: string | null }>;
let messagesStore: Map<string, Array<{ id: string; role: string; content: string }>>;
let wiringStore: Map<string, string[]>;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  updateExtension: async () => null,
  listExtensions: async () => Array.from(store.values()),
}));

// Spread the real `conversations` queries module so unrelated exports
// (getConversationSpawnDepth, createMessage, etc. that ToolExecutor
// imports) aren't dropped by the partial mock. We only override the
// two queries the runtime-invoke handler reads.
const realConversations = await import("../db/queries/conversations");
mock.module("../db/queries/conversations", () => ({
  ...realConversations,
  getConversation: async (id: string) =>
    (conversationStore.get(id) as unknown) ?? null,
  getMessages: async (id: string) =>
    (messagesStore.get(id) as unknown) ?? [],
}));

const realConvExt = await import("../db/queries/conversation-extensions");
mock.module("../db/queries/conversation-extensions", () => ({
  ...realConvExt,
  getConversationExtensionIds: async (id: string) => wiringStore.get(id) ?? [],
}));

// ── Lazy imports AFTER mocks ────────────────────────────────────────

const { bootSpawnFlaggedBundledExtensions } = await import("../extensions/bundled");
const { ExtensionRegistry } = await import("../extensions/registry");
const { EventBus } = await import("../runtime/events");
const { EventSubscriptionDispatcher } = await import(
  "../extensions/event-subscription-dispatcher"
);
const { ToolExecutor } = await import("../extensions/tool-executor");

// Build a manifest for the fixture matching the bundled-extension shape.
function makeFixtureManifest() {
  return {
    schemaVersion: 2 as const,
    name: HIJACK_NAME,
    version: "1.0.0",
    description: "Test fixture (event-only).",
    author: { name: "Test" },
    entrypoint: FIXTURE_ENTRYPOINT,
    persistent: true,
    tools: [],
    permissions: {
      eventSubscriptions: ["run:complete"],
    },
  };
}

// Track every registry/process we create so afterEach can tear them
// down — even if a test asserts and short-circuits, the subprocess
// MUST be killed so the bun-test runner exits cleanly.
// `ExtensionRegistry` has a private constructor (singleton — see
// `registry.ts:213`), so `InstanceType<typeof ExtensionRegistry>`
// fails strict TS with "Cannot assign a private constructor type to a
// public constructor type" (TS2344). Use the return type of the
// public `getInstance()` factory instead.
let registry: ReturnType<typeof ExtensionRegistry.getInstance> | null = null;
let dispatcher: InstanceType<typeof EventSubscriptionDispatcher> | null = null;

beforeAll(() => {
  store = new Map();
  conversationStore = new Map();
  messagesStore = new Map();
  wiringStore = new Map();
});

afterEach(() => {
  if (dispatcher) {
    try { dispatcher.stop(); } catch { /* ignore */ }
    dispatcher = null;
  }
  if (registry) {
    try { registry.killAll(); } catch { /* ignore */ }
    registry = null;
  }
  // Symmetric with the per-test `resetInstance()` below: drop the
  // singleton AFTER killAll so the next test (in this file or any
  // other) gets a fresh registry. Bun's test runner shares the
  // module graph across files, so a leaked singleton would carry
  // state between unrelated suites.
  ExtensionRegistry.resetInstance();
  store.clear();
  conversationStore.clear();
  messagesStore.clear();
  wiringStore.clear();
});

afterAll(() => restoreModuleMocks());

// ── Test ────────────────────────────────────────────────────────────

describe("bootSpawnFlaggedBundledExtensions — real subprocess (Phase 53.6)", () => {
  test("spawns a real subprocess AND delivers run:complete to it", async () => {
    // 1. DB row for the hijacked bundled slot.
    store.set(HIJACK_NAME, { id: EXT_ID, name: HIJACK_NAME, enabled: true });

    // 2. Real registry, fixture manifest registered via test seams.
    //    `resetInstance()` drops any prior singleton (from another
    //    test file in the same `bun test` invocation) so we start
    //    from a known-empty registry. Then `getInstance()` creates a
    //    fresh one. The constructor is private — singleton API is
    //    the only public path.
    ExtensionRegistry.resetInstance();
    registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest(EXT_ID, makeFixtureManifest());
    registry.setInstallPathForTest(EXT_ID, FIXTURE_DIR);
    registry.setGrantedPermsForTest(EXT_ID, { grantedAt: {} });

    // 3. Capture notifications coming back from the subprocess. The
    //    fixture echoes a `test/received` notification when it sees
    //    `ezcorp/event/run:complete`.
    const received: JsonRpcNotification[] = [];
    const wireRpc = async (
      _extensionId: string,
      proc: import("../extensions/subprocess").ExtensionProcess,
    ) => {
      proc.setNotificationHandler((n) => received.push(n));
    };

    // 4. Boot-spawn — the unit under test.
    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(result.spawned).toContain(HIJACK_NAME);
    expect(result.failed).not.toContain(HIJACK_NAME);

    // 5. The proc must actually be running. This is the assertion the
    //    pre-existing stub-based tests cannot make: in production the
    //    helper used to skip `ensureRunning()`, so `proc.proc` stayed
    //    null and `isRunning` was false. After 30f7498 it must be true.
    const proc = registry.getProcessIfRunning(EXT_ID);
    expect(proc).not.toBeNull();
    expect(proc?.isRunning).toBe(true);

    // 6. End-to-end dispatch: emit a synthetic `run:complete` through
    //    a real dispatcher; the fixture echoes a notification back.
    const bus = new EventBus<import("../types").AgentEvents>();
    const CONV_ID = "conv-real-1";
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      registry,
      // Wired-extensions lookup mirrors `autoWireBundledExtensions`
      // having inserted a conversation_extensions row at conv-create
      // time. For this test we hard-code the wiring on the test conv id.
      async (convId: string) => (convId === CONV_ID ? [EXT_ID] : []),
    );
    dispatcher.registerExtension(EXT_ID, ["run:complete"]);
    dispatcher.start();

    bus.emit("run:complete", {
      conversationId: CONV_ID,
    } as import("../types").AgentEvents["run:complete"]);

    // The dispatcher's bus listener is async (awaits the wired-ext
    // lookup), then the subprocess has to read its stdin and write a
    // line back to stdout, then the host has to flush its read loop.
    // 2000ms is generous for the round-trip on a healthy machine; raise
    // if this becomes flaky on slower CI hardware.
    await waitFor(() => received.some((n) => n.method === "test/received"), 2000);

    const echo = received.find((n) => n.method === "test/received");
    expect(echo).toBeDefined();
    expect(echo?.params).toMatchObject({
      conversationId: CONV_ID,
      originalMethod: "ezcorp/event/run:complete",
    });
  }, 10_000);

  // ── Phase 53.7 — reverse-RPC round-trip via the eventDriven gate ──
  //
  // Pre-fix the boot executor's `currentConversationId` was null, so
  // ANY runtime.* call from a boot-spawned subprocess (driven by
  // `run:complete`) was rejected with -32604. The lessons-distiller +
  // memory-extractor extensions silently swallowed the rejection, so
  // the auto-trigger flow looked healthy in CI while doing nothing in
  // production.
  //
  // Phase 53.7 fix: when the boot executor sets `eventDriven: true`,
  // the conversation-scope gate falls back to a `conversation_extensions`
  // wiring lookup. This test exercises the full chain — fixture
  // subprocess receives `run:complete`, issues a reverse-RPC, and the
  // host responds with a real envelope. The fixture echoes the
  // outcome via a `test/rpc-result` notification the host asserts on.
  test("reverse-RPC succeeds via wiring fallback when boot executor is eventDriven (M1)", async () => {
    // 1. DB row for the hijacked bundled slot.
    store.set(HIJACK_NAME, { id: EXT_ID, name: HIJACK_NAME, enabled: true });

    // 2. Conversation + messages the RPC will read. These have to exist
    //    so `runtime.conversations.getMessages` returns a real envelope
    //    instead of -32604 not-found.
    const CONV_ID = "conv-rpc-1";
    conversationStore.set(CONV_ID, { id: CONV_ID, projectId: "proj-1" });
    messagesStore.set(CONV_ID, [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "world" },
    ]);

    // 3. Wiring row — same trust source the dispatcher consulted to
    //    deliver the event in the first place. The gate falls back to
    //    this when the strict currentConversationId match fails.
    wiringStore.set(CONV_ID, [EXT_ID]);

    // 4. Real registry, RPC fixture manifest registered via test seams.
    ExtensionRegistry.resetInstance();
    registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest(EXT_ID, {
      ...makeFixtureManifest(),
      // Override entrypoint to point at the RPC fixture.
      entrypoint: "./entrypoint.ts",
    });
    registry.setInstallPathForTest(EXT_ID, RPC_FIXTURE_DIR);
    registry.setGrantedPermsForTest(EXT_ID, { grantedAt: {} });

    // 5. Capture notifications. The fixture echoes a `test/rpc-result`
    //    notification carrying the round-trip outcome.
    const received: JsonRpcNotification[] = [];

    // 6. Build a real ToolExecutor with `eventDriven: true` (matches
    //    the boot executor in `web/src/lib/server/context.ts`). Its
    //    `ensureSubprocessRpcWired` installs the production reverse-
    //    RPC handler that routes `runtime.*` through
    //    `handleRuntimeInvoke` with the eventDriven flag + wiringLookup
    //    threaded into the ctx.
    //
    //    The PermissionEngine here is the minimal stub the boot path
    //    uses — runtime.* invocations route past the engine entirely
    //    (see tool-executor.ts handlePiInvoke), so a no-op stub is
    //    sufficient. If a future refactor adds engine.authorize on the
    //    runtime.* path, this test will fail loudly and the harness
    //    needs a real engine.
    const stubEngine = {
      authorize: async () => ({ outcome: "allow" as const }),
      resolvePrompt: async () => undefined,
    } as unknown as ConstructorParameters<typeof ToolExecutor>[1];
    const bus = new EventBus<import("../types").AgentEvents>();
    const bootExecutor = new ToolExecutor(registry, stubEngine, {
      bus,
      eventDriven: true,
    });

    const wireRpc = async (
      extId: string,
      proc: import("../extensions/subprocess").ExtensionProcess,
    ) => {
      // Capture notifications BEFORE wiring the request handler so the
      // fixture's echo lands in `received`. The boot executor only
      // installs a notification handler if a state mediator is
      // configured (which we don't here), so our handler stays
      // installed for the lifetime of the proc.
      proc.setNotificationHandler((n) => received.push(n));
      await bootExecutor.ensureSubprocessRpcWired(extId, proc);
    };

    // 7. Boot-spawn — same chain as the existing test but with the
    //    real reverse-RPC handler installed.
    const result = await bootSpawnFlaggedBundledExtensions(registry, wireRpc);

    expect(result.spawned).toContain(HIJACK_NAME);
    expect(result.failed).not.toContain(HIJACK_NAME);

    const proc = registry.getProcessIfRunning(EXT_ID);
    expect(proc).not.toBeNull();
    expect(proc?.isRunning).toBe(true);

    // 8. Dispatch the event. The fixture will issue
    //    `runtime.conversations.getMessages` back into the host.
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      registry,
      async (convId: string) => wiringStore.get(convId) ?? [],
    );
    dispatcher.registerExtension(EXT_ID, ["run:complete"]);
    dispatcher.start();

    bus.emit("run:complete", {
      conversationId: CONV_ID,
    } as import("../types").AgentEvents["run:complete"]);

    // 9. Wait for the fixture's `test/rpc-result` notification. The
    //    round-trip is async (event delivery → fixture writes RPC →
    //    host reads, dispatches, replies → fixture reads response →
    //    fixture writes echo). 4000ms is generous.
    await waitFor(
      () => received.some((n) => n.method === "test/rpc-result"),
      4000,
    );

    const echo = received.find((n) => n.method === "test/rpc-result");
    expect(echo).toBeDefined();
    // CRITICAL assertion: the RPC succeeded. Pre-fix this would be
    // `ok: false, code: -32604` because the strict gate rejected the
    // call. Post-fix the wiring lookup matches and the host returns
    // the messages envelope. messageCount=2 proves we got the actual
    // payload back, not an empty pass-through.
    expect(echo?.params).toMatchObject({
      conversationId: CONV_ID,
      ok: true,
      messageCount: 2,
    });
  }, 10_000);
});

/** Poll-and-yield until `predicate` returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  // Timed out — let the calling assertion produce the failure message.
}
