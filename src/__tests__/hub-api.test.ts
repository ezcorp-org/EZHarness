/**
 * Extension Pages Hub — API route integration tests (PGlite + real
 * handlers).
 *
 *   GET  /api/hub/pages                       → 200, 401, 403; core +
 *        extension listings, disabled/malformed filtering
 *   GET  /api/hub/pages/[id]                  → 200, 200+{error}, 401,
 *        403, 404 (malformed/unknown/ext-in-phase-1), 429
 *   POST /api/hub/pages/[id]/actions/[action] → 200 (±tree), 400, 401,
 *        403, 404, 429, HubPageActionError mapping, 500
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();
mock.module("$server/runtime/hub-pages", () => require("../runtime/hub-pages"));
mock.module("$server/extensions/page-schema", () => require("../extensions/page-schema"));
mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
const realLogger = require("../logger");
mock.module("$server/logger", () => realLogger);
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/security/rate-limiter", () => require("../../web/src/lib/server/security/rate-limiter"));
mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
mock.module("../../web/src/routes/api/hub/pages/$types", () => ({}));
mock.module("../../web/src/routes/api/hub/pages/[id]/$types", () => ({}));
mock.module("../../web/src/routes/api/hub/pages/[id]/actions/[action]/$types", () => ({}));

// Controllable render-pull fake: the render route's EXT branch is unit
// tested here against this seam; the real module's branches are covered
// in hub-render-pull.test.ts.
let __extRenderResult: unknown = { notFound: true };
mock.module("$lib/server/hub-render-pull", () => ({
  renderExtensionPage: async (...args: unknown[]) => {
    __extRenderCalls.push(args);
    return __extRenderResult;
  },
}));
const __extRenderCalls: unknown[][] = [];

// ── Handler imports (dynamic — AFTER the mocks bind) ──────────────
const { GET: listGet } = await import("../../web/src/routes/api/hub/pages/+server");
const { GET: renderGet, __rateLimiter: renderLimiter } = await import(
  "../../web/src/routes/api/hub/pages/[id]/+server"
);
const { POST: actionPost, __rateLimiter: actionLimiter } = await import(
  "../../web/src/routes/api/hub/pages/[id]/actions/[action]/+server"
);

// ── Backing modules ──────────────────────────────────────────────
import {
  registerHubPageProvider,
  HubPageActionError,
  _resetHubPageProvidersForTests,
  type HubPageProvider,
} from "../runtime/hub-pages";
import { users, extensions } from "../db/schema";
import type { ExtensionManifestV2 } from "../extensions/types";

let userA: AuthUser;

function makeManifest(overrides: Record<string, unknown> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "cron-dash",
    version: "1.0.0",
    description: "d",
    author: { name: "t" },
    permissions: {},
    ...overrides,
  } as ExtensionManifestV2;
}

function registerDemoProvider(overrides: Partial<HubPageProvider> = {}): void {
  registerHubPageProvider({
    id: "demo",
    title: "Demo",
    icon: "Sparkles",
    description: "demo page",
    render: async () => ({
      title: "Demo",
      nodes: [
        { type: "heading", level: 2, text: "Hello" },
        { type: "button", label: "Go", action: { event: "go" } },
      ],
    }),
    actions: { go: async () => undefined },
    ...overrides,
  });
}

async function call(handler: (event: ReturnType<typeof createMockEvent>) => Promise<Response>, event: ReturnType<typeof createMockEvent>): Promise<Response> {
  try {
    return await handler(event);
  } catch (e) {
    return e as Response; // requireAuth throws a Response
  }
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  // In-file ≥2-registration pattern (mock-cleanup meta-test): these
  // factories point at the REAL modules, so re-registering them keeps
  // subsequent files clean without adding the web-lib module graphs to
  // the eager MODULE_PATHS preload.
  mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$lib/server/hub-render-pull", () => require("../../web/src/lib/server/hub-render-pull"));
  mock.module("$server/logger", () => realLogger);
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetHubPageProvidersForTests();
  renderLimiter.reset();
  actionLimiter.reset();
  __extRenderResult = { notFound: true };
  __extRenderCalls.length = 0;
  const db = getTestDb();
  await db.delete(extensions);
  await db.delete(users);
  const [u1] = await db.insert(users).values({ email: "a@t.local", passwordHash: "x", name: "A" }).returning();
  userA = { id: u1!.id, email: u1!.email, name: u1!.name, role: "member" };
});

// ── GET /api/hub/pages ────────────────────────────────────────────

describe("GET /api/hub/pages", () => {
  test("401 unauthenticated", async () => {
    const res = await call(listGet, createMockEvent({}));
    expect(res.status).toBe(401);
  });

  test("403 when the API key lacks the read scope", async () => {
    const event = createMockEvent({ user: userA });
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["chat"];
    const res = await call(listGet, event);
    expect(res.status).toBe(403);
  });

  test("200 lists core providers in registration order", async () => {
    registerDemoProvider();
    registerHubPageProvider({
      id: "second",
      title: "Second",
      render: async () => ({ title: "S", nodes: [] }),
    });
    const res = await call(listGet, createMockEvent({ user: userA }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.pages).toEqual([
      { id: "core:demo", title: "Demo", icon: "Sparkles", description: "demo page", kind: "core" },
      { id: "core:second", title: "Second", kind: "core" },
    ]);
  });

  test("includes enabled extensions' declared pages; skips disabled + malformed", async () => {
    const db = getTestDb();
    await db.insert(extensions).values([
      {
        name: "cron-dash",
        version: "1.0.0",
        source: "local:/x",
        enabled: true,
        manifest: makeManifest({
          pages: [
            { id: "dashboard", title: "Cron Dashboard", icon: "Clock" },
            { id: "BAD ID", title: "nope" }, // malformed: dropped defensively
            { id: "no-title" }, // malformed: dropped
          ],
        }),
        grantedPermissions: { grantedAt: {} },
      },
      {
        name: "disabled-ext",
        version: "1.0.0",
        source: "local:/y",
        enabled: false,
        manifest: makeManifest({ name: "disabled-ext", pages: [{ id: "p", title: "P" }] }),
        grantedPermissions: { grantedAt: {} },
      },
      {
        name: "no-pages",
        version: "1.0.0",
        source: "local:/z",
        enabled: true,
        manifest: makeManifest({ name: "no-pages" }),
        grantedPermissions: { grantedAt: {} },
      },
    ]);

    const res = await call(listGet, createMockEvent({ user: userA }));
    const data = await jsonFromResponse(res);
    expect(data.pages).toEqual([
      { id: "ext:cron-dash:dashboard", title: "Cron Dashboard", icon: "Clock", kind: "ext" },
    ]);
  });
});

// ── GET /api/hub/pages/[id] ───────────────────────────────────────

describe("GET /api/hub/pages/[id]", () => {
  test("401 / 403", async () => {
    expect((await call(renderGet, createMockEvent({ params: { id: "core:demo" } }))).status).toBe(401);
    const event = createMockEvent({ user: userA, params: { id: "core:demo" } });
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["chat"];
    expect((await call(renderGet, event)).status).toBe(403);
  });

  test("404 for malformed ids, unknown providers, and unresolved ext pages", async () => {
    registerDemoProvider();
    for (const id of ["", "garbage", "core:", "core:UPPER", "core:nope", "ext:cron-dash:page", "core:demo:extra"]) {
      const res = await call(renderGet, createMockEvent({ user: userA, params: { id } }));
      expect(res.status).toBe(404);
    }
  });

  test("ext branch: success result passes page + renderedAt (+ stale) through", async () => {
    const tree = { title: "Cron Dashboard", nodes: [] };
    __extRenderResult = { page: tree, renderedAt: 123, stale: true };
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "ext:cron-dash:dashboard" } }));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ page: tree, renderedAt: 123, stale: true });
    // The route forwards the parsed segments + session user.
    expect(__extRenderCalls).toEqual([["cron-dash", "dashboard", userA.id]]);

    // Fresh (non-stale) results omit the stale key.
    __extRenderResult = { page: tree, renderedAt: 456 };
    const fresh = await call(renderGet, createMockEvent({ user: userA, params: { id: "ext:cron-dash:dashboard" } }));
    expect(await jsonFromResponse(fresh)).toEqual({ page: tree, renderedAt: 456 });
  });

  test("ext branch: render-pull {error} becomes the 200 error envelope", async () => {
    __extRenderResult = { error: "This page failed to render — try again." };
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "ext:cron-dash:dashboard" } }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("failed to render");
    expect(data.page).toBeUndefined();
  });

  test("200 renders + validates a core page (allowed action survives)", async () => {
    registerDemoProvider();
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.page.title).toBe("Demo");
    expect(data.page.nodes).toHaveLength(2);
    expect(data.renderedAt).toBeGreaterThan(0);
  });

  test("render receives the session user's id", async () => {
    let seen: string | undefined;
    registerDemoProvider({
      render: async (ctx) => {
        seen = ctx.userId;
        return { title: "D", nodes: [] };
      },
    });
    await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    expect(seen).toBe(userA.id);
  });

  test("disallowed action nodes are stripped by the uniform validation", async () => {
    registerDemoProvider({
      render: async () => ({
        title: "Demo",
        nodes: [{ type: "button", label: "Forged", action: { event: "not-an-action" } }],
      }),
    });
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    const data = await jsonFromResponse(res);
    expect(data.page.nodes).toHaveLength(0);
  });

  test("200 + {error} when the provider throws", async () => {
    registerDemoProvider({
      render: async () => {
        throw new Error("boom");
      },
    });
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("failed to render");
    expect(data.page).toBeUndefined();
  });

  test("200 + {error} when the provider returns an invalid envelope", async () => {
    registerDemoProvider({
      render: async () => ({ nodes: [] }) as never,
    });
    const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("invalid content");
  });

  test("429 after 12 renders/min, keyed per user+page", async () => {
    registerDemoProvider();
    registerHubPageProvider({ id: "other", title: "O", render: async () => ({ title: "O", nodes: [] }) });
    for (let i = 0; i < 12; i++) {
      const res = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
      expect(res.status).toBe(200);
    }
    const blocked = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:demo" } }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Different page id — separate bucket.
    const other = await call(renderGet, createMockEvent({ user: userA, params: { id: "core:other" } }));
    expect(other.status).toBe(200);
  });
});

// ── POST /api/hub/pages/[id]/actions/[action] ─────────────────────

function actionEvent(opts: { id?: string; action?: string; body?: unknown; user?: AuthUser } = {}) {
  return createMockEvent({
    method: "POST",
    body: opts.body ?? {},
    user: opts.user ?? userA,
    params: { id: opts.id ?? "core:demo", action: opts.action ?? "go" },
  });
}

describe("POST /api/hub/pages/[id]/actions/[action]", () => {
  test("401 / 403", async () => {
    registerDemoProvider();
    const unauth = createMockEvent({ method: "POST", body: {}, params: { id: "core:demo", action: "go" } });
    expect((await call(actionPost, unauth)).status).toBe(401);
    const event = actionEvent();
    (event.locals as { apiKeyScopes?: string[] }).apiKeyScopes = ["read"];
    expect((await call(actionPost, event)).status).toBe(403);
  });

  test("404: ext ids, malformed ids, bad action names, unregistered actions", async () => {
    registerDemoProvider();
    expect((await call(actionPost, actionEvent({ id: "ext:x:y" }))).status).toBe(404);
    expect((await call(actionPost, actionEvent({ id: "core:nope" }))).status).toBe(404);
    expect((await call(actionPost, actionEvent({ action: "NOT VALID" }))).status).toBe(404);
    expect((await call(actionPost, actionEvent({ action: "unknown" }))).status).toBe(404);
  });

  test("200 {ok:true} when the handler returns nothing; payload threaded through", async () => {
    let seenPayload: Record<string, unknown> | undefined;
    let seenUser: string | undefined;
    registerDemoProvider({
      actions: {
        go: async (ctx, payload) => {
          seenUser = ctx.userId;
          seenPayload = payload;
          return undefined;
        },
      },
    });
    const res = await call(actionPost, actionEvent({ body: { payload: { scope: "all" } } }));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ ok: true });
    expect(seenUser).toBe(userA.id);
    expect(seenPayload).toEqual({ scope: "all" });
  });

  test("missing body / missing payload are fine (payload undefined)", async () => {
    let seenPayload: unknown = "sentinel";
    registerDemoProvider({
      actions: {
        go: async (_ctx, payload) => {
          seenPayload = payload;
          return undefined;
        },
      },
    });
    const res = await call(actionPost, actionEvent({ body: {} }));
    expect(res.status).toBe(200);
    expect(seenPayload).toBeUndefined();
  });

  test("400 for oversized or non-object payloads", async () => {
    registerDemoProvider();
    const big = { payload: { blob: "x".repeat(3000) } };
    expect((await call(actionPost, actionEvent({ body: big }))).status).toBe(400);
    expect((await call(actionPost, actionEvent({ body: { payload: ["arr"] } }))).status).toBe(400);
    expect((await call(actionPost, actionEvent({ body: { payload: "str" } }))).status).toBe(400);
  });

  test("400 for an array request body", async () => {
    registerDemoProvider();
    expect((await call(actionPost, actionEvent({ body: ["not-an-object"] }))).status).toBe(400);
  });

  test("200 with a validated fresh tree", async () => {
    registerDemoProvider({
      actions: {
        go: async () => ({
          title: "Fresh",
          nodes: [
            { type: "text", content: "updated" },
            { type: "button", label: "Forged", action: { event: "evil" } }, // stripped
          ],
        }),
      },
    });
    const res = await call(actionPost, actionEvent());
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
    expect(data.page.title).toBe("Fresh");
    expect(data.page.nodes).toHaveLength(1);
    expect(data.renderedAt).toBeGreaterThan(0);
  });

  test("handler returning an invalid envelope degrades to {ok:true}", async () => {
    registerDemoProvider({
      actions: { go: async () => ({ bogus: true }) as never },
    });
    const res = await call(actionPost, actionEvent());
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ ok: true });
  });

  test("HubPageActionError maps to its status + retryAfter", async () => {
    registerDemoProvider({
      actions: {
        go: async () => {
          throw new HubPageActionError(429, "slow down", 120);
        },
      },
    });
    const res = await call(actionPost, actionEvent());
    expect(res.status).toBe(429);
    const data = await jsonFromResponse(res);
    expect(data.error).toBe("slow down");
    expect(data.retryAfter).toBe(120);
    expect(res.headers.get("Retry-After")).toBe("120");
  });

  test("HubPageActionError without retryAfter omits the header", async () => {
    registerDemoProvider({
      actions: {
        go: async () => {
          throw new HubPageActionError(503, "not yet");
        },
      },
    });
    const res = await call(actionPost, actionEvent());
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("generic errors map to 500", async () => {
    registerDemoProvider({
      actions: {
        go: async () => {
          throw new Error("kaboom");
        },
      },
    });
    const res = await call(actionPost, actionEvent());
    expect(res.status).toBe(500);
  });

  test("429 after 10 actions/min/user", async () => {
    registerDemoProvider();
    for (let i = 0; i < 10; i++) {
      expect((await call(actionPost, actionEvent())).status).toBe(200);
    }
    const blocked = await call(actionPost, actionEvent());
    expect(blocked.status).toBe(429);
  });
});

// ── findEnabledExtensionPage (hub-extension-pages lookup) ─────────

describe("findEnabledExtensionPage", () => {
  const { findEnabledExtensionPage } = require("../../web/src/lib/server/hub-extension-pages");

  test("resolves a declared page on an enabled extension", async () => {
    const db = getTestDb();
    await db.insert(extensions).values({
      name: "cron-dash",
      version: "1.0.0",
      source: "local:/x",
      enabled: true,
      manifest: makeManifest({ pages: [{ id: "dashboard", title: "Dash" }] }),
      grantedPermissions: { grantedAt: {} },
    });
    const found = await findEnabledExtensionPage("cron-dash", "dashboard");
    expect(found).not.toBeNull();
    expect(found!.extension.name).toBe("cron-dash");
    expect(found!.page).toEqual({ id: "dashboard", title: "Dash" });
  });

  test("null for unknown extension, disabled extension, and undeclared page", async () => {
    const db = getTestDb();
    await db.insert(extensions).values({
      name: "off-ext",
      version: "1.0.0",
      source: "local:/y",
      enabled: false,
      manifest: makeManifest({ name: "off-ext", pages: [{ id: "p", title: "P" }] }),
      grantedPermissions: { grantedAt: {} },
    });
    expect(await findEnabledExtensionPage("nope", "p")).toBeNull();
    expect(await findEnabledExtensionPage("off-ext", "p")).toBeNull();

    await db.insert(extensions).values({
      name: "on-ext",
      version: "1.0.0",
      source: "local:/z",
      enabled: true,
      manifest: makeManifest({ name: "on-ext", pages: [{ id: "p", title: "P" }] }),
      grantedPermissions: { grantedAt: {} },
    });
    expect(await findEnabledExtensionPage("on-ext", "other")).toBeNull();
  });
});
