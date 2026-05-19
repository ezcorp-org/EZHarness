// GAP 2 regression coverage — dispatcher reverse-RPC provenance.
//
// Background fires used to carry NO provenance, so a subscriber's
// reverse-RPC (memory-extractor's `ctx.llm` on `run:complete`, a cron
// fire calling a capability) hit the "missing onBehalfOf" throw / 90s
// watchdog hang. The fix mints a host-issued `ezCallId` correlation
// token PER FIRE and attaches it as `_meta.ezCallId` on the
// notification, so the reverse-RPC resolves to either the conversation
// owner (event subscription) or a clean ownerless soft-fail (cron).
//
// This file locks in the *provenance* contract of the two dispatchers
// (the broader behavioral contracts already have dedicated suites):
//
//   (a) event-subscription dispatch attaches a resolvable
//       `_meta.ezCallId` whose snapshot carries the CONVERSATION's
//       resolved userId (getConversation mocked).
//   (b) when the conversation has no userId → the token is
//       `ownerless: true` (clean soft-fail, not a throw).
//   (c) schedule-daemon cron fire attaches an `ownerless: true` token
//       and the "no resolvable owner" info-log path runs.
//
// We resolve the token the dispatcher actually minted — proving the
// reverse-RPC handler downstream would see the right identity.

import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";
import {
  resolveCallProvenance,
  _resetCallProvenanceForTests,
} from "../call-provenance";

// ── (a) + (b): event-subscription dispatch ──────────────────────────
//
// Mock getConversation so we control the owner. EventBus is real;
// registry + proc are in-memory fakes (mirrors
// event-subscription-dispatcher.test.ts's harness).

let convUserId: string | null = "owner-user-1";
mock.module("../../db/queries/conversations", () => ({
  getConversation: async (_id: string) =>
    convUserId === null ? { id: _id, userId: null } : { id: _id, userId: convUserId },
}));
// Silence audit DB writes (no PGlite in this suite).
mock.module("../../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

const { EventBus } = await import("../../runtime/events");
const { EventSubscriptionDispatcher } = await import(
  "../event-subscription-dispatcher"
);
type AgentEvents = import("../../types").AgentEvents;

interface SendCall { method: string; params: Record<string, unknown>; }
function mockProc() {
  const calls: SendCall[] = [];
  return {
    isRunning: true,
    calls,
    sendNotification(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
    },
  };
}
function mockRegistry(procs: Map<string, ReturnType<typeof mockProc>>) {
  return {
    getProcessIfRunning(extensionId: string) {
      const p = procs.get(extensionId);
      return p?.isRunning ? p : null;
    },
  } as never;
}
function wireLookup(map: Record<string, string[]>) {
  return async (convId: string) => map[convId] ?? [];
}
function snapshotPayload(conversationId: string): unknown {
  return { conversationId, tasks: [], activeTaskId: undefined };
}

describe("dispatcher provenance — event subscription (GAP 2 a/b)", () => {
  beforeEach(() => {
    _resetCallProvenanceForTests();
    convUserId = "owner-user-1";
  });
  afterEach(() => _resetCallProvenanceForTests());

  test("(a) dispatch attaches a resolvable _meta.ezCallId carrying the conversation's resolved userId", async () => {
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ c1: ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 25));

    expect(proc.calls).toHaveLength(1);
    const meta = (proc.calls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(typeof meta?.ezCallId).toBe("string");

    const prov = resolveCallProvenance(meta!.ezCallId!);
    expect(prov).toBeDefined();
    expect(prov!.onBehalfOf).toBe("owner-user-1");
    expect(prov!.conversationId).toBe("c1");
    expect(prov!.ownerless).toBe(false);
    expect(prov!.kind).toBe("event");
    // actorExtensionId is host-owned (the subscriber), never the wire.
    expect(prov!.actorExtensionId).toBe("ext-a");
  });

  test("(b) conversation with no userId → token is ownerless:true", async () => {
    convUserId = null;
    const bus = new EventBus<AgentEvents>();
    const proc = mockProc();
    const dispatcher = new EventSubscriptionDispatcher(
      bus,
      mockRegistry(new Map([["ext-a", proc]])),
      wireLookup({ c1: ["ext-a"] }),
    );
    dispatcher.registerExtension("ext-a", ["task:snapshot"]);
    dispatcher.start();

    bus.emit("task:snapshot", snapshotPayload("c1") as AgentEvents["task:snapshot"]);
    await new Promise((r) => setTimeout(r, 25));

    expect(proc.calls).toHaveLength(1);
    const meta = (proc.calls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    const prov = resolveCallProvenance(meta!.ezCallId!);
    expect(prov).toBeDefined();
    expect(prov!.ownerless).toBe(true);
    expect(prov!.onBehalfOf).toBeNull();
  });
});

// ── (c): schedule-daemon cron fire ──────────────────────────────────
//
// dispatchFire writes the fire row, so it needs the PGlite test DB
// harness (mirrors schedule-daemon.test.ts). We capture the
// notification, resolve the minted token, and assert ownerless:true.

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));
mockDbConnection();

const { ScheduleDaemon } = await import("../schedule-daemon");
const { extensionSchedules, extensions } = await import("../../db/schema");

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: {
      schemaVersion: 2, name, version: "0.0.1", description: "",
      author: { name: "t" }, permissions: {},
    } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

describe("dispatcher provenance — schedule-daemon cron fire (GAP 2 c)", () => {
  let extId: string;

  beforeAll(async () => {
    await setupTestDb();
    extId = await ensureExtension("prov-sched-ext");
  });
  afterAll(async () => {
    restoreModuleMocks();
    await closeTestDb();
  });
  beforeEach(() => _resetCallProvenanceForTests());
  afterEach(() => _resetCallProvenanceForTests());

  // The minted ownerless token IS the proof the "no resolvable owner"
  // soft-fail path ran — `registerFireCallProvenance({ownerless:true})`
  // and the info log sit on the same unconditional branch in
  // `dispatchFire` (a cron fire has no conversation/user by design).
  test("(c) cron fire attaches an ownerless:true token (no-resolvable-owner soft-fail path)", async () => {
    const past = new Date(Date.now() - 60_000);
    await getTestDb().insert(extensionSchedules).values({
      extensionId: extId, cron: "0 * * * *",
      nextFireAt: past, enabled: true,
    });

    let captured: { method: string; params: Record<string, unknown> } | null = null;
    const daemon = new ScheduleDaemon({
      registry: {
        getProcessIfRunning() {
          return {
            isRunning: true,
            sendNotification(method: string, params?: Record<string, unknown>) {
              captured = { method, params: params ?? {} };
            },
          } as never;
        },
      },
    });

    await daemon.tick();
    daemon.stop();

    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("ezcorp/schedule-fire");
    const meta = (captured!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(typeof meta?.ezCallId).toBe("string");

    const prov = resolveCallProvenance(meta!.ezCallId!);
    expect(prov).toBeDefined();
    expect(prov!.ownerless).toBe(true);
    expect(prov!.onBehalfOf).toBeNull();
    expect(prov!.conversationId).toBeNull();
    expect(prov!.kind).toBe("schedule");
    expect(prov!.actorExtensionId).toBe(extId);
  });
});
