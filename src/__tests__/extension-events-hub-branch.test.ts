/**
 * POST /api/extensions/[name]/events/[event] — hub-source branch
 * (Extension Pages Hub §2.4).
 *
 * Sister of extension-event-end-to-end.test.ts: same mock scaffolding,
 * but drives the `{source:"hub", pageId, payload?}` body shape:
 * manifest-event gate (shared with the legacy branch), declared-page
 * gate, 10/min/user rate limit, spawn+wire, `ezcorp/event/<ext>:<event>`
 * notification with host-stamped userId, page-cache invalidation.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

import {
  registerExtensionEvent,
  unregisterExtensionEvent,
} from "../runtime/sse-conversation-filter";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { getPageCache } from "../extensions/page-cache";
import {
  resolveCallProvenance,
  _resetCallProvenanceForTests,
} from "../extensions/call-provenance";
// The REAL logger module — remapped onto the `$server/logger` alias below so
// the route's logging goes to the genuine sink (not a stub that would leak into
// sibling files). `../logger` itself is never mocked, so a top-level import is
// order-safe (unlike the lazy `require`s in the mock.module factories).
import * as realLogger from "../logger";

// ── Subprocess + registry fakes ─────────────────────────────────────
interface SendCall { method: string; params: Record<string, unknown> }
const sendCalls: SendCall[] = [];
let spawnShouldFail = false;
let wireCalls = 0;

// ── Gate-push service-conversation fakes (ECF control plane, L1) ─────
// A gate push carries `payload.projectRoot`; the route resolves it to a
// REGISTERED project, find-or-creates the per-(project, extension) service
// conversation, and wires the extension into it. These handles let the tests
// drive project resolution (present/absent) and observe the find-or-create +
// wiring calls.
let mockProject: { id: string; name: string; path: string } | null = null;
let getServiceConvCalls: Array<{ extensionName: string; projectId: string; userId: string; title: string }> = [];
const SERVICE_CONV_ID = "svc-conv-1";
let serviceConvWiring: Array<{ conversationId: string; extensionId: string }> = [];
// When true, the service-conv resolver throws — exercises the route's
// record-and-continue catch (fail closed to null scope, never a 500).
let serviceConvThrows = false;
let alreadyWiredExtIds: string[] = [];

const fakeProc = {
  sendNotification(method: string, params?: Record<string, unknown>) {
    sendCalls.push({ method, params: params ?? {} });
  },
};

mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getProcess: async (_id: string) => {
        if (spawnShouldFail) throw new Error("spawn exploded");
        return fakeProc;
      },
    }),
  },
}));
mock.module("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    async ensureSubprocessRpcWired() {
      wireCalls++;
    }
  },
}));
mock.module("$server/extensions/permission-engine", () => ({
  getPermissionEngine: () => ({}),
}));

// ── Extension row lookup — DELEGATING stub ──────────────────────────
// ORDER-COUPLING GUARD (sister file: hub-api.test.ts). The REAL
// $lib/server/hub-extension-pages module (registered below) first
// materializes DURING THIS FILE and permanently freezes its imported
// query bindings to THIS registration — bun never retro-patches an
// already-imported binding, so a plain fixture stub here would keep
// serving `mockExt` / `[]` to every LATER file in the same process
// (hub-api.test.ts's real-DB listing + findEnabledExtensionPage tests
// fail when this file runs first). Two rules keep this order-safe:
//   1. DELEGATE: while this file is active the stub serves the fixture;
//      after afterAll flips the flag, calls fall through to the GENUINE
//      query functions (whose DB handle resolves per-call, so a later
//      file's mockDbConnection applies normally).
//   2. FULL SURFACE: spread the genuine module — bun freezes a
//      specifier's export SHAPE at first materialization, so a partial
//      stub breaks later files' named imports with "Export named X not
//      found".
import * as realExtensionQueries from "../db/queries/extensions";
let hubBranchFileActive = true;
let mockExt: Record<string, unknown> | null = null;
mock.module("$server/db/queries/extensions", () => ({
  ...realExtensionQueries,
  getExtensionByName: async (name: string) =>
    hubBranchFileActive ? mockExt : realExtensionQueries.getExtensionByName(name),
  // hub-extension-pages also imports the list query (unused by the
  // hub-action branch, but the module must instantiate).
  listExtensions: async () =>
    hubBranchFileActive ? [] : realExtensionQueries.listExtensions(),
}));

// Unused-by-the-hub-branch lookups still imported by the route module.
// `getOrCreateExtServiceConversation` is the gate-push owner resolver — it
// MUST be exported here (partial stubs freeze the specifier shape and break
// the route's named import otherwise).
mock.module("$server/db/queries/conversations", () => ({
  getConversation: async () => null,
  getOrCreateExtServiceConversation: async (opts: {
    extensionName: string; projectId: string; userId: string; title: string;
  }) => {
    if (serviceConvThrows) throw new Error("db down");
    getServiceConvCalls.push(opts);
    return { id: SERVICE_CONV_ID, kind: "ext-service", userId: opts.userId, projectId: opts.projectId };
  },
}));
mock.module("$server/db/queries/projects", () => ({
  getProjectByPath: async (path: string) =>
    mockProject && mockProject.path === path ? mockProject : undefined,
}));
mock.module("$server/db/queries/tool-calls", () => ({
  getToolCallConversationById: async () => null,
}));
mock.module("$server/db/queries/conversation-extensions", () => ({
  addConversationExtensions: async (
    conversationId: string,
    entries: { extensionId: string }[],
  ) => {
    for (const e of entries) serviceConvWiring.push({ conversationId, extensionId: e.extensionId });
  },
  getConversationExtensionIds: async () => alreadyWiredExtIds,
}));
mock.module("$server/extensions/append-message-handler", () => ({
  handleAppendMessageRpc: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
}));
mock.module("$server/extensions/finalize-tool-call-handler", () => ({
  handleFinalizeToolCallRpc: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
}));

// ── Auth / scope / helpers ──────────────────────────────────────────
// REAL modules (not always-allow stubs): the mock events below carry
// `locals.user`, so the genuine gates pass for our requests — and a
// stub here would leak an always-authenticated requireAuth into any
// test file sharing the process (briefing-api's 401/403 cases).
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$server/auth/middleware", () => require("../auth/middleware"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/server/security/rate-limiter", () => require("../../web/src/lib/server/security/rate-limiter"));
// REAL module — it materializes during this file and freezes its
// query bindings to the delegating stub above (see the order-coupling
// guard comment there before touching either registration).
mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));
mock.module("$server/logger", () => realLogger);

const bus = new EventBus<AgentEvents>();
mock.module("$lib/server/context", () => ({
  getBus: () => bus,
  // The route's spawn-path re-wire also imports getExecutor; a partial mock
  // that omits it fails EVERY import from the module at load. Throwing
  // exercises the route's guarded executor-less test path.
  getExecutor: () => {
    throw new Error("executor not booted (test context)");
  },
}));

const { POST, __hubActionRateLimiter } = await import(
  "../../web/src/routes/api/extensions/[name]/events/[event]/+server"
);

afterAll(() => {
  unregisterExtensionEvent("cron-dashboard", "clear-log");
  // Flip the delegating extension-queries stub to call-through mode:
  // the real hub-extension-pages instance materialized in THIS file
  // keeps these stub functions forever (frozen bindings), so this flag
  // — not restoreModuleMocks — is what un-poisons later files.
  hubBranchFileActive = false;
  mockExt = null;
  // In-file ≥2-registration pattern (mock-cleanup meta-test): both
  // factories point at the real modules.
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$server/logger", () => realLogger);
  restoreModuleMocks();
});

const EXT_NAME = "cron-dashboard";
const EVENT = "clear-log";

function makeEvent(body: unknown, name = EXT_NAME, event = EVENT) {
  return {
    request: new Request(`http://localhost/api/extensions/${name}/events/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    locals: { user: { id: "user-1", email: "u@x.com", name: "U", role: "member" } },
    params: { name, event },
  } as never;
}

function baseExt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ext-cron",
    name: EXT_NAME,
    enabled: true,
    manifest: { pages: [{ id: "dashboard", title: "Dash" }] },
    grantedPermissions: { eventSubscriptions: [`${EXT_NAME}:${EVENT}`], grantedAt: {} },
    ...overrides,
  };
}

beforeEach(() => {
  registerExtensionEvent(EXT_NAME, EVENT);
  sendCalls.length = 0;
  wireCalls = 0;
  spawnShouldFail = false;
  mockExt = baseExt();
  __hubActionRateLimiter.reset();
  getPageCache().clear();
  _resetCallProvenanceForTests();
  mockProject = null;
  getServiceConvCalls = [];
  serviceConvWiring = [];
  alreadyWiredExtIds = [];
  serviceConvThrows = false;
});

describe("hub-source branch", () => {
  test("200: spawns + wires, sends the namespaced notification with host-stamped userId + a resolvable provenance token", async () => {
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard", payload: { all: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wireCalls).toBe(1);
    expect(sendCalls).toHaveLength(1);
    const call = sendCalls[0]!;
    expect(call.method).toBe(`ezcorp/event/${EXT_NAME}:${EVENT}`);
    // The non-`_meta` params are the host-stamped action body (unchanged).
    const { _meta, ...body } = call.params as Record<string, unknown> & {
      _meta?: { ezCallId?: string };
    };
    expect(body).toEqual({ source: "hub", pageId: "dashboard", userId: "user-1", payload: { all: true } });
    // Bug A regression guard: the page-action dispatch MUST carry a
    // host-issued reverse-RPC provenance token, and it must resolve to the
    // CLICKING user (onBehalfOf), not be ownerless. Without it every
    // downstream host-mediated reverse-RPC the action triggers (fs.write +
    // any provenance-gated capability) fails `-32602` provenance-unresolved.
    const ezCallId = _meta?.ezCallId;
    expect(typeof ezCallId).toBe("string");
    expect(resolveCallProvenance(ezCallId)).toMatchObject({
      onBehalfOf: "user-1",
      actorExtensionId: "ext-cron",
      kind: "event",
      ownerless: false,
      conversationId: null,
    });
  });

  test("payload key omitted from the notification when absent (provenance still stamped)", async () => {
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(200);
    const { _meta, ...body } = sendCalls[0]!.params as Record<string, unknown> & {
      _meta?: { ezCallId?: string };
    };
    expect(body).toEqual({ source: "hub", pageId: "dashboard", userId: "user-1" });
    expect(typeof _meta?.ezCallId).toBe("string");
  });

  // ── Gate-push service-conversation owner (ECF control plane, L1) ────

  test("gate push with a REGISTERED projectRoot: token carries the service conversation, ext wired", async () => {
    mockProject = { id: "proj-1", name: "My App", path: "/repos/my-app" };
    const res = await POST(makeEvent({
      source: "hub",
      pageId: "dashboard",
      payload: { projectRoot: "/repos/my-app", repoId: "abc123abc123", branch: "main" },
    }));
    expect(res.status).toBe(200);

    // The service conversation was found-or-created for THIS (project, ext),
    // owned by the gate-key user, with a recognizable title.
    expect(getServiceConvCalls).toHaveLength(1);
    expect(getServiceConvCalls[0]).toEqual({
      extensionName: EXT_NAME,
      projectId: "proj-1",
      userId: "user-1",
      title: `${EXT_NAME} gate — My App`,
    });
    // The extension was wired into the service conversation (spawn wiring gate).
    expect(serviceConvWiring).toContainEqual({ conversationId: SERVICE_CONV_ID, extensionId: "ext-cron" });
    // The minted token carries the service conversation id (so a push-fired
    // spawn derives the project from it) and stays owner-scoped (not ownerless).
    const meta = (sendCalls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(resolveCallProvenance(meta!.ezCallId!)).toMatchObject({
      onBehalfOf: "user-1",
      conversationId: SERVICE_CONV_ID,
      ownerless: false,
    });
  });

  test("gate push whose projectRoot is NOT a registered project: fails closed to null scope", async () => {
    mockProject = null; // getProjectByPath returns undefined
    const res = await POST(makeEvent({
      source: "hub",
      pageId: "dashboard",
      payload: { projectRoot: "/repos/unknown", repoId: "abc123abc123", branch: "main" },
    }));
    expect(res.status).toBe(200);
    // No service conversation, no wiring — the token is null-scope, exactly as
    // before the fix, so the spawn keeps rejecting (never borrow ambient scope).
    expect(getServiceConvCalls).toHaveLength(0);
    expect(serviceConvWiring).toHaveLength(0);
    const meta = (sendCalls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(resolveCallProvenance(meta!.ezCallId!)).toMatchObject({ conversationId: null });
  });

  test("service-conv resolution THROWING fails closed to null scope — never a 500, event still delivered", async () => {
    mockProject = { id: "proj-1", name: "My App", path: "/repos/my-app" };
    serviceConvThrows = true; // resolver blows up (e.g. db down)
    const res = await POST(makeEvent({
      source: "hub",
      pageId: "dashboard",
      payload: { projectRoot: "/repos/my-app", repoId: "abc123abc123", branch: "main" },
    }));
    // The catch is record-and-continue: the fire still dispatches…
    expect(res.status).toBe(200);
    expect(sendCalls).toHaveLength(1);
    expect(serviceConvWiring).toHaveLength(0);
    // …but the token stays conversationless (fail-closed — spawn will reject
    // rather than borrow ambient scope).
    const meta = (sendCalls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(resolveCallProvenance(meta!.ezCallId!)).toMatchObject({
      onBehalfOf: "user-1",
      conversationId: null,
      ownerless: false,
    });
  });

  test("gate push reuses an already-wired service conversation (no duplicate wiring)", async () => {
    mockProject = { id: "proj-1", name: "My App", path: "/repos/my-app" };
    alreadyWiredExtIds = ["ext-cron"]; // extension already wired
    const res = await POST(makeEvent({
      source: "hub",
      pageId: "dashboard",
      payload: { projectRoot: "/repos/my-app", repoId: "abc123abc123", branch: "main" },
    }));
    expect(res.status).toBe(200);
    expect(getServiceConvCalls).toHaveLength(1);
    // Idempotent: no redundant wiring write when the ext is already wired.
    expect(serviceConvWiring).toHaveLength(0);
    const meta = (sendCalls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(resolveCallProvenance(meta!.ezCallId!)).toMatchObject({ conversationId: SERVICE_CONV_ID });
  });

  test("plain hub click (no projectRoot) never touches the service-conversation path", async () => {
    mockProject = { id: "proj-1", name: "My App", path: "/repos/my-app" };
    await POST(makeEvent({ source: "hub", pageId: "dashboard", payload: { all: true } }));
    expect(getServiceConvCalls).toHaveLength(0);
    expect(serviceConvWiring).toHaveLength(0);
    const meta = (sendCalls[0]!.params as { _meta?: { ezCallId?: string } })._meta;
    expect(resolveCallProvenance(meta!.ezCallId!)).toMatchObject({ conversationId: null });
  });

  test("invalidates the page cache for the targeted page", async () => {
    getPageCache().set("ext-cron", "dashboard", { title: "T", nodes: [] });
    getPageCache().set("ext-cron", "other", { title: "O", nodes: [] });
    await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(getPageCache().get("ext-cron", "dashboard")).toBeNull();
    expect(getPageCache().get("ext-cron", "other")).not.toBeNull();
  });

  test("400 for malformed hub bodies", async () => {
    for (const body of [
      { source: "hub" }, // missing pageId
      { source: "hub", pageId: "BAD ID" },
      { source: "hub", pageId: "dashboard", payload: "string" },
      { source: "hub", pageId: "dashboard", payload: ["arr"] },
    ]) {
      const res = await POST(makeEvent(body));
      expect(res.status).toBe(400);
    }
    expect(sendCalls).toHaveLength(0);
  });

  test("400 for payloads over 2KB", async () => {
    const res = await POST(
      makeEvent({ source: "hub", pageId: "dashboard", payload: { blob: "x".repeat(3000) } }),
    );
    expect(res.status).toBe(400);
  });

  test("404 when the event isn't registered in the manifest-event registry", async () => {
    unregisterExtensionEvent(EXT_NAME, EVENT);
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(404);
  });

  test("404 for unknown or disabled extensions", async () => {
    mockExt = null;
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
    mockExt = baseExt({ enabled: false });
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
  });

  test("404 when the page isn't declared in manifest.pages", async () => {
    expect((await POST(makeEvent({ source: "hub", pageId: "undeclared" }))).status).toBe(404);
    mockExt = baseExt({ manifest: {} });
    expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(404);
    expect(sendCalls).toHaveLength(0);
  });

  test("429 after 10 actions/min/user", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(makeEvent({ source: "hub", pageId: "dashboard" }))).status).toBe(200);
    }
    const blocked = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(sendCalls).toHaveLength(10);
  });

  test("500 when the subprocess can't spawn (action must not vanish silently)", async () => {
    spawnShouldFail = true;
    const res = await POST(makeEvent({ source: "hub", pageId: "dashboard" }));
    expect(res.status).toBe(500);
    expect(sendCalls).toHaveLength(0);
  });

  test("non-hub bodies fall through to the legacy conversation-scoped schema", async () => {
    // No `source:"hub"` → legacy schema requires conversationId etc.
    const res = await POST(makeEvent({ pageId: "dashboard" }));
    expect(res.status).toBe(400); // legacy schema rejects, hub branch untouched
    expect(sendCalls).toHaveLength(0);
  });
});
