import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { buildFirstPartyRelease } from "./helpers/first-party-release";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { configureReleaseRuntime } from "../extensions/release-process";
import { getExtensionLifecycle } from "../extensions/extension-lifecycle-service";
import { enqueueExtensionNotification, startExtensionDeliveryRuntime, stopExtensionDeliveryRuntime } from "../extensions/delivery-runtime";
import { and, eq } from "drizzle-orm";
import {
  setupTestDb,
  getTestDb,
  closeTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

// ── Seam 1: the LLM boundary ────────────────────────────────────────
//
// `llm-handler.ts` imports `piComplete` from `../lib/pi-complete` and
// dynamic-imports `getCredential` from `../providers/credentials`. Both
// are replaced so no provider key and no network are needed; every gate
// ABOVE them (grant check, model allowlist, quota, provenance) still
// runs for real.

interface PiCall {
  systemPrompt?: string;
  userText: string;
  maxTokens?: number;
  temperature?: number;
}
const piCalls: PiCall[] = [];
/** What the fake model returns; each case sets its own slug so a
 *  partial-unique slug collision can never mask a real result. */
let llmResponseText = "EMPTY";

mock.module("../lib/pi-complete", () => ({
  piComplete: async (
    _piModel: unknown,
    body: { systemPrompt?: string; messages: Array<{ content: string }> },
    opts: { maxTokens?: number; temperature?: number },
  ) => {
    piCalls.push({
      ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
      userText: body.messages.map((m) => m.content).join("\n"),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
    return {
      content: [{ type: "text", text: llmResponseText }],
      usage: { input: 10, output: 20 },
      stopReason: "stop",
      model: "gemini-2.0-flash-lite",
    };
  },
}));

const realCredentials = await import("../providers/credentials");
mock.module("../providers/credentials", () => ({
  ...realCredentials,
  getCredential: async () => ({ type: "apikey", token: "integration-test-key" }),
}));

// ── Seam 2: a RECORDING pass-through on resolveExtensionSettings ────
//
// Not a stub — the real resolver still runs against the real DB. The
// wrapper exists so the acting `userId` the host threads in is directly
// observable (bug 1's whole point).

interface SettingsResolution {
  extensionId: string;
  userId: string | null;
}
const settingsResolutions: SettingsResolution[] = [];

const realExtSettings = await import("../db/queries/extension-settings");
// Capture the function VALUE before `mock.module` runs. Reading it off
// the namespace inside the wrapper would resolve to the mock (Bun
// rebinds the live namespace), and the pass-through would recurse until
// the stack blew — which surfaces as a `-32603 settings resolve failed`
// on the wire, not as a test error.
const realResolveExtensionSettings = realExtSettings.resolveExtensionSettings;
mock.module("../db/queries/extension-settings", () => ({
  ...realExtSettings,
  resolveExtensionSettings: async (
    extensionId: string,
    userId: string | null,
    schema?: Parameters<typeof realResolveExtensionSettings>[2],
  ) => {
    settingsResolutions.push({ extensionId, userId });
    return realResolveExtensionSettings(extensionId, userId, schema);
  },
}));

// ── Lazy imports AFTER the mocks ────────────────────────────────────

const { ExtensionRegistry } = await import("../extensions/registry");
const { ToolExecutor } = await import("../extensions/tool-executor");
const { EventBus } = await import("../runtime/events");
const { EventSubscriptionDispatcher } = await import(
  "../extensions/event-subscription-dispatcher"
);
const { _resetCallProvenanceForTests } = await import("../extensions/call-provenance");
const { getConversationExtensionIds } = await import("../db/queries/conversation-extensions");
const {
  users,
  messages,
  conversationExtensions,
  extensionSettingsUser,
  toolCalls,
  lessons,
} = await import("../db/schema");
import type { JsonRpcRequest, JsonRpcResponse } from "../extensions/types";

let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
let session: Awaited<ReturnType<typeof release.session>>;
const deliveries: Promise<void>[] = [];
let OWNER_ID: string;
const OTHER_ID = "user-distill-bystander";
let PROJECT_ID: string;
let CONV_ID: string;
let EXT_ID: string;

/** The finished run's `startedAt`. Tool-call rows straddle it. */
const RUN_STARTED_MS = Date.UTC(2026, 6, 31, 12, 0, 0);
/** Comfortably before / after the run window. */
const BEFORE_RUN_MS = RUN_STARTED_MS - 60_000;
const AFTER_RUN_MS = RUN_STARTED_MS + 5_000;

// ── Reverse-RPC frame recorder ──────────────────────────────────────
//
// Wraps (never replaces) the handler `ensureSubprocessRpcWired`
// installs, so every frame the subprocess sends AND the response the
// REAL host computes for it are observable.

interface Frame {
  method: string;
  tool?: string;
  args: Record<string, unknown>;
  response: JsonRpcResponse;
}
const frames: Frame[] = [];

function invokeFrames(tool: string): Frame[] {
  return frames.filter((f) => f.method === "ezcorp/invoke" && f.tool === tool);
}

function frameResult<T>(frame: Frame | undefined): T | undefined {
  return (frame?.response as { result?: T } | undefined)?.result;
}

let registry: ReturnType<typeof ExtensionRegistry.getInstance> | null = null;
let dispatcher: InstanceType<typeof EventSubscriptionDispatcher> | null = null;
let bus: InstanceType<typeof EventBus<import("../types").AgentEvents>>;

beforeAll(async () => {
  await setupTestDb();
  await getExtensionLifecycle();
  release = await buildFirstPartyRelease("lessons-distiller");
  session = await release.session({ persistRelease: true });
  OWNER_ID = session.userId;
  PROJECT_ID = session.projectId;
  CONV_ID = session.conversationId;
  EXT_ID = session.id;
  const db = getTestDb();
  await db.insert(users).values({ id: OTHER_ID, email: "bystander@distill.local", passwordHash: "x", name: "Bystander" });
  // The latest user message is deliberately signal-FREE: no correction
  // token, no `[lesson]` tag. That leaves the tool-call count as the
  // ONLY gate signal, so each case's verdict is attributable to the run
  // window and nothing else.
  await db.insert(messages).values([
    { id: "m1", conversationId: CONV_ID, role: "user", content: "summarise the build output" },
    { id: "m2", conversationId: CONV_ID, role: "assistant", content: "the build produced 3 warnings" },
  ] as never);
  // The wiring row the dispatcher AND the event-driven conversation gate
  // both read — the single trust source for "this extension may see this
  // conversation".
  await db.insert(conversationExtensions).values({
    id: "convext-1", conversationId: CONV_ID, extensionId: EXT_ID,
  } as never);
  // Negative control. A SECOND user has the distiller switched ON. If
  // the host ever resolved the wrong identity (or fell back to declared
  // defaults, which are also `enabled: true`), case 1 would distill —
  // so its "nothing happened" assertions only hold when the resolved
  // user is genuinely the conversation owner.
  await db.insert(extensionSettingsUser).values({
    userId: OTHER_ID, extensionId: EXT_ID, values: { enabled: true },
  } as never);

  _resetCallProvenanceForTests();

  registry = session.registry;
  bus = new EventBus<import("../types").AgentEvents>();
  const bootExecutor = new ToolExecutor(registry, createStubPermissionEngine("allow-all"), { bus, eventDriven: true });

  const wireRpc = async (
    extId: string,
    proc: import("../extensions/subprocess").ExtensionProcess,
  ) => {
    // Record around the production handler rather than replacing it:
    // `setRequestHandler` is intercepted so the handler
    // `ensureSubprocessRpcWired` installs is wrapped, not shadowed.
    const install = proc.setRequestHandler.bind(proc);
    proc.setRequestHandler = (handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>) => {
      install(async (req: JsonRpcRequest) => {
        const response = await handler(req);
        const params = (req.params ?? {}) as Record<string, unknown>;
        frames.push({
          method: req.method,
          ...(typeof params.tool === "string" ? { tool: params.tool } : {}),
          args: (params.arguments ?? params) as Record<string, unknown>,
          response,
        });
        return response;
      });
    };
    await bootExecutor.ensureSubprocessRpcWired(extId, proc);
  };

  configureReleaseRuntime({
    ...session.runtime,
    dispatchNotification: async (id, method, params) => {
      const delivery = enqueueExtensionNotification(id, method, params ?? {});
      deliveries.push(delivery);
      await delivery;
    },
  });
  startExtensionDeliveryRuntime((id, process) => { void wireRpc(id, process); });

  dispatcher = new EventSubscriptionDispatcher(
    bus,
    registry,
    // Production lookup — the real `conversation_extensions` query.
    getConversationExtensionIds,
  );
  dispatcher.registerExtension(EXT_ID, release.manifest.permissions?.eventSubscriptions ?? []);
  dispatcher.start();
}, 120_000);

afterAll(async () => {
  dispatcher?.stop();
  await stopExtensionDeliveryRuntime();
  await session?.close();
  await release?.close();
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  restoreModuleMocks();
});

/** Store the owner's per-user settings row (the values the fix must
 *  resolve INSTEAD of the manifest's declared defaults). */
async function setOwnerSettings(values: Record<string, unknown>): Promise<void> {
  const db = getTestDb();
  await db
    .delete(extensionSettingsUser)
    .where(
      and(
        eq(extensionSettingsUser.userId, OWNER_ID),
        eq(extensionSettingsUser.extensionId, EXT_ID),
      ),
    );
  await db.insert(extensionSettingsUser).values({
    userId: OWNER_ID, extensionId: EXT_ID, values,
  } as never);
}

/** Insert tool-call rows at an explicit `created_at` (the column the
 *  gate's SQL window filters on). `persistToolCall` can't set it. */
async function seedToolCalls(count: number, createdAtMs: number, idPrefix: string): Promise<void> {
  const db = getTestDb();
  for (let i = 0; i < count; i++) {
    await db.insert(toolCalls).values({
      id: `${idPrefix}-${i}`,
      conversationId: CONV_ID,
      messageId: null,
      extensionId: EXT_ID,
      toolName: "some_tool",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 5,
      // +i ms so the ORDER BY is deterministic and every row sits on the
      // intended side of the run boundary.
      createdAt: new Date(createdAtMs + i),
    } as never);
  }
}

/** Emit a real `run:complete` through the real dispatcher and wait for
 *  the subprocess's reverse-RPC storm to settle. The dispatcher mints
 *  the fire provenance token itself — nothing here is hand-minted. */
async function fireRunComplete(runId: string, startedAt: number): Promise<void> {
  const before = deliveries.length;
  bus.emit("run:complete", {
    conversationId: CONV_ID,
    run: { id: runId, agentName: "chat", status: "success", startedAt },
  } as unknown as import("../types").AgentEvents["run:complete"]);
  await waitFor(() => deliveries.length > before, 10_000);
  await Promise.all(deliveries.slice(before));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Expected event delivery did not start");
}

function reset(): void {
  frames.length = 0;
  piCalls.length = 0;
  settingsResolutions.length = 0;
}

describe("lessons-distiller ↔ host — the seam, end to end", () => {
  test("bug 1: the fire resolves the CONVERSATION OWNER's settings, and their off switch suppresses the distill", async () => {
    reset();
    // Manifest default is `enabled: true`. The owner turned it OFF.
    await setOwnerSettings({ enabled: false, provider: "google", model: "" });

    await fireRunComplete("run-owner-off", RUN_STARTED_MS);

    // (a) The acting user threaded into `runtime.settings.getMine` is the
    //     conversation owner — NOT null, NOT the executor singleton
    //     (which is undefined on this boot executor).
    const settingsFrames = invokeFrames("runtime.settings.getMine");
    expect(settingsFrames.length).toBeGreaterThanOrEqual(1);
    expect(settingsResolutions.length).toBeGreaterThanOrEqual(1);
    for (const r of settingsResolutions) {
      expect(r.extensionId).toBe(EXT_ID);
      expect(r.userId).toBe(OWNER_ID);
      expect(r.userId).not.toBe(OTHER_ID);
    }

    // …and the host actually returned the OWNER's stored row, not the
    // manifest's declared defaults.
    expect(frameResult<Record<string, unknown>>(settingsFrames[0])).toMatchObject({
      enabled: false,
    });

    // (b) The off switch works on the auto path: the distiller stops
    //     before the conversation read, so no gate, no LLM, no write.
    expect(invokeFrames("runtime.conversations.getMessages")).toEqual([]);
    expect(invokeFrames("runtime.lessons.triggerGate")).toEqual([]);
    expect(frames.filter((f) => f.method === "ezcorp/llm-complete")).toEqual([]);
    expect(frames.filter((f) => f.method === "ezcorp/lessons")).toEqual([]);
    expect(piCalls).toEqual([]);
    expect(await getTestDb().select().from(lessons)).toEqual([]);
  }, 60_000);

  test("bug 2: tool calls recorded BEFORE run.startedAt do not count — the real host declines", async () => {
    reset();
    await setOwnerSettings({ enabled: true, provider: "google", model: "" });
    // Six calls, all BEFORE the run began. Over `TOOL_CALL_THRESHOLD`
    // (5) on the conversation-lifetime reading, so the pre-fix gate
    // would have fired here and paid for an LLM call.
    await seedToolCalls(6, BEFORE_RUN_MS, "tc-pre");

    await fireRunComplete("run-scope-decline", RUN_STARTED_MS);

    // The run scope the extension SENDS is the scope the host READS —
    // exact param names, straight off the `run:complete` payload.
    const gateFrames = invokeFrames("runtime.lessons.triggerGate");
    expect(gateFrames.length).toBe(1);
    expect(gateFrames[0]!.args).toEqual({
      conversationId: CONV_ID,
      runId: "run-scope-decline",
      runStartedAtMs: RUN_STARTED_MS,
    });

    // The host's own verdict: zero in-window tool calls, decline.
    const verdict = frameResult<{ shouldDistill: boolean; reason: string }>(gateFrames[0]);
    expect(verdict?.shouldDistill).toBe(false);
    expect(verdict?.reason).toContain("toolCalls=0");
    expect(verdict?.reason).toContain(`window=run:run-scope-decline@`);

    // Nothing billable ran, and the conversation was read exactly once.
    expect(invokeFrames("runtime.conversations.getMessages").length).toBe(1);
    expect(frames.filter((f) => f.method === "ezcorp/llm-complete")).toEqual([]);
    expect(piCalls).toEqual([]);
    expect(await getTestDb().select().from(lessons)).toEqual([]);
  }, 60_000);

  test("bug 2: 5 tool calls AFTER run.startedAt fire the gate and land a lesson owned by the conversation owner", async () => {
    reset();
    llmResponseText = JSON.stringify({
      slug: "scope-the-gate-to-the-run",
      title: "Scope the distill gate to one run",
      body: "Signals measured over a conversation's lifetime go sticky; scope them to the finished run.",
      frontmatter: { trigger: ["gate design"], applies_to: ["domain:lessons"], confidence: "high" },
    });
    // The six pre-run rows from the previous case are still there, so the
    // conversation lifetime now holds ELEVEN calls while the run window
    // holds exactly five.
    await seedToolCalls(5, AFTER_RUN_MS, "tc-post");

    await fireRunComplete("run-scope-fire", RUN_STARTED_MS);

    const gateFrames = invokeFrames("runtime.lessons.triggerGate");
    expect(gateFrames.length).toBe(1);
    const verdict = frameResult<{ shouldDistill: boolean; reason: string }>(gateFrames[0]);
    expect(verdict?.shouldDistill).toBe(true);

    // The LLM ran — with the distiller's prompt and the real conversation
    // slice the host handed back.
    expect(piCalls.length).toBe(1);
    expect(piCalls[0]!.systemPrompt).toContain("lessons-keeper");
    expect(piCalls[0]!.userText).toContain("summarise the build output");

    // …and the lesson landed, stamped host-side with the CONVERSATION
    // OWNER as its owner (the provenance token's `onBehalfOf`) — bug 1's
    // fix proven a second way, on the write path.
    const rows = await getTestDb().select().from(lessons);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      slug: "scope-the-gate-to-the-run",
      visibility: "user",
      source: "extension",
      authorExtensionId: EXT_ID,
    });
  }, 60_000);
});
