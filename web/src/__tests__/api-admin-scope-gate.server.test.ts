/**
 * F2 regression suite — the SECOND authorization axis on admin write routes.
 *
 * `requireRole(locals, "admin")` proves the PRINCIPAL is an admin. It says
 * nothing about what an API key was SCOPED for. A key minted
 * `--scopes read --role admin` is an admin principal carrying a read-only
 * scope, so on a `requireRole`-only route it reached admin WRITES — the
 * organization's LLM API key, BYOK search keys, MCP server configs.
 * `src/auth/middleware.ts` documents exactly this in `checkRole`'s docblock.
 *
 * Every route below now gates on `checkRole(locals, "admin")`, which enforces
 * BOTH axes and RETURNS the denial instead of throwing (a thrown Response is
 * rendered by SvelteKit as a 500, not the intended 403 — finding F6).
 *
 * The table drives four probes per handler so a fix that simply denies
 * everyone cannot pass:
 *   1. admin-role key, scopes ["read"]  → 403, and the write never happens.
 *   2. cookie session, role admin        → allowed (carries no apiKeyScopes).
 *   3. admin-role key, scopes ["admin"]  → allowed.
 *   4. member cookie session             → 403 (the role axis still bites).
 * Plus: every denial is RETURNED, never thrown.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";

// ── Mocks (hoisted handles so the module factories can close over them) ──
const h = vi.hoisted(() => ({
  getSetting: vi.fn(async (_k: string) => undefined as unknown),
  // Params are declared so `mock.calls` keeps a tuple shape the `([k]) =>`
  // destructuring below can index.
  upsertSetting: vi.fn(async (_k: string, _v?: unknown) => undefined),
  deleteSetting: vi.fn(async (_k: string) => true),
  insertAuditEntry: vi.fn(async () => undefined),
  encrypt: vi.fn((p: string) => `enc:${p}`),
  decrypt: vi.fn((c: string) => c),
  getExtension: vi.fn(async (_id: string) => null as unknown),
  setExtensionModifiable: vi.fn(async () => null as unknown),
  installMcpExtension: vi.fn(async () => ({ id: "ext-mcp" })),
  updateMcpExtension: vi.fn(async () => ({ id: "ext-mcp" })),
  rehydrateMcpServerSecrets: vi.fn(async (_n: string, s: unknown) => s),
  reload: vi.fn(async () => undefined),
  refreshMcpTools: vi.fn(async () => [] as unknown[]),
  mcpConnect: vi.fn(async () => undefined),
  mcpListTools: vi.fn(async () => [] as unknown[]),
  mcpClose: vi.fn(async () => undefined),
  listModels: vi.fn(async () => ({ models: [] })),
  checkLocalModel: vi.fn(async () => ({ ok: true })),
  // ── F6 second wave: the five handlers that still gated on ROLE alone ──
  getAllSettings: vi.fn(async () => ({ "provider:defaultSelection": "auto" }) as Record<string, unknown>),
  listInvites: vi.fn(async () => [] as unknown[]),
  createInvite: vi.fn(async () => ({
    id: "inv-1",
    token: "tok-1",
    email: "x@y.z",
    role: "admin",
    expiresAt: new Date(0),
  })),
  getCredential: vi.fn(async () => ({ token: "sk-instance-byok" })),
  findModelForProviderInTier: vi.fn(() => ({ id: "m-fast" })),
  resolveModelObject: vi.fn(() => ({ id: "m-fast" })),
  complete: vi.fn(async () => ({ content: "ok" })),
  fetchProviderModels: vi.fn(async () => [{ id: "m-1" }]),
}));

vi.mock("$server/db/queries/settings", () => ({
  getSetting: h.getSetting,
  upsertSetting: h.upsertSetting,
  deleteSetting: h.deleteSetting,
  getAllSettings: h.getAllSettings,
}));
vi.mock("$server/db/queries/invites", () => ({
  listInvites: h.listInvites,
  createInvite: h.createInvite,
}));
vi.mock("$server/providers/credentials", () => ({ getCredential: h.getCredential }));
vi.mock("$server/providers/registry", () => ({
  findModelForProviderInTier: h.findModelForProviderInTier,
  resolveModelObject: h.resolveModelObject,
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: h.complete }));
vi.mock("$server/providers/model-discovery", () => ({ fetchProviderModels: h.fetchProviderModels }));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: h.insertAuditEntry }));
vi.mock("$server/providers/encryption", () => ({ encrypt: h.encrypt, decrypt: h.decrypt }));
vi.mock("$server/db/queries/extensions", () => ({
  getExtension: h.getExtension,
  setExtensionModifiable: h.setExtensionModifiable,
  installMcpExtension: h.installMcpExtension,
  updateMcpExtension: h.updateMcpExtension,
  rehydrateMcpServerSecrets: h.rehydrateMcpServerSecrets,
}));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: h.reload, refreshMcpTools: h.refreshMcpTools }),
  },
}));
vi.mock("$server/mcp/client", () => ({
  McpClient: class {
    connect = h.mcpConnect;
    listTools = h.mcpListTools;
    close = h.mcpClose;
  },
}));
vi.mock("$server/providers/local-model-check", () => ({
  listModels: h.listModels,
  checkLocalModel: h.checkLocalModel,
}));
// The SSRF guards are not what this suite is about — let them pass so an
// ungated call visibly reaches the privileged body. `checkLocalProviderTarget`
// is the local-provider routes' single entry point into that guard (it wraps
// the two helpers below plus the loopback carve-out), so it is stubbed here
// too — otherwise every "…still succeeds" case fails on the missing export
// rather than on the scope decision this suite exists to test.
vi.mock("$lib/server/security/url-validation", () => ({
  isPrivateOrLoopback: () => false,
  resolveAndValidateHostname: async () => ({ ok: true }),
  checkLocalProviderTarget: async () => ({ ok: true }),
}));

const providers = await import("../routes/api/providers/+server.ts");
const searchBackend = await import("../routes/api/search/backend/+server.ts");
const mcpServers = await import("../routes/api/mcp-servers/+server.ts");
const mcpServerId = await import("../routes/api/mcp-servers/[id]/+server.ts");
const mcpRefresh = await import("../routes/api/mcp-servers/[id]/refresh/+server.ts");
const localModels = await import("../routes/api/providers/local/models/+server.ts");
const localTest = await import("../routes/api/providers/local/test/+server.ts");
const modifiable = await import("../routes/api/extensions/[id]/modifiable/+server.ts");
const settingsRoot = await import("../routes/api/settings/+server.ts");
const invite = await import("../routes/api/auth/invite/+server.ts");
const providerTest = await import("../routes/api/providers/[provider]/test/+server.ts");
const providerRefresh = await import("../routes/api/providers/[provider]/refresh-models/+server.ts");

// ── Principals ───────────────────────────────────────────────────────
const ADMIN = { id: "admin-1", email: "a@x", name: "a", role: "admin" };
const MEMBER = { id: "u-2", email: "u@x", name: "u", role: "member" };

/** The attack: an admin PRINCIPAL whose key was scoped read-only. */
const ADMIN_ROLE_READ_KEY = { user: ADMIN, apiKeyScopes: ["read"] };
/** A browser session — carries no apiKeyScopes at all. */
const ADMIN_COOKIE = { user: ADMIN };
/** A correctly-minted admin key. */
const ADMIN_SCOPED_KEY = { user: ADMIN, apiKeyScopes: ["admin"] };
/** Role axis control: a properly scoped key whose principal is NOT an admin. */
const MEMBER_COOKIE = { user: MEMBER };

const MCP_SERVER = { transport: "http", name: "srv", url: "https://mcp.example.com" };

function evt(path: string, method: string, body?: unknown, params?: Record<string, string>) {
  return (locals: Record<string, unknown>) =>
    ({
      url: new URL(`http://localhost${path}`),
      locals,
      params: params ?? {},
      request: new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    }) as never;
}

interface Probe {
  /** Handler + event factory. */
  call: (locals: Record<string, unknown>) => Promise<Response>;
  /** Arms mocks so an ungated call reaches — and visibly performs — the write. */
  arm: () => void;
  /** True once the privileged operation actually executed. */
  breached: () => boolean;
}

/** Set by `invoke` when the handler DENIED by throwing its Response rather
 *  than returning it. SvelteKit renders a thrown Response as a 500, so this
 *  flag is the F6 assertion surface. */
let lastCallThrew = false;

/** Normalize the two denial styles so one probe works before AND after the
 *  fix: `requireRole` THREW its Response, `checkRole` returns it. */
async function invoke(
  handler: (e: never) => unknown,
  makeEvent: (l: Record<string, unknown>) => never,
  locals: Record<string, unknown>,
): Promise<Response> {
  lastCallThrew = false;
  try {
    return (await handler(makeEvent(locals))) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) {
      lastCallThrew = true;
      return thrown;
    }
    throw thrown;
  }
}

const ROUTES: Record<string, Probe> = {
  "POST /api/providers": {
    call: (l) =>
      invoke(providers.POST, evt("/api/providers", "POST", { provider: "openai", apiKey: "sk-pwn" }), l),
    arm: () => {},
    breached: () => h.upsertSetting.mock.calls.some(([k]) => k === "provider:apiKey:openai"),
  },
  "DELETE /api/providers": {
    call: (l) => invoke(providers.DELETE, evt("/api/providers", "DELETE", { provider: "anthropic" }), l),
    arm: () => {},
    breached: () => h.deleteSetting.mock.calls.some(([k]) => k === "provider:apiKey:anthropic"),
  },
  "GET /api/search/backend": {
    call: (l) => invoke(searchBackend.GET, evt("/api/search/backend", "GET"), l),
    arm: () => {},
    breached: () => h.getSetting.mock.calls.length > 0,
  },
  "POST /api/search/backend": {
    call: (l) =>
      invoke(searchBackend.POST, evt("/api/search/backend", "POST", { provider: "tavily", apiKey: "tv-pwn" }), l),
    arm: () => {},
    breached: () => h.upsertSetting.mock.calls.some(([k]) => k === "provider:apiKey:tavily"),
  },
  "DELETE /api/search/backend": {
    call: (l) => invoke(searchBackend.DELETE, evt("/api/search/backend", "DELETE", { provider: "brave" }), l),
    arm: () => {},
    breached: () => h.deleteSetting.mock.calls.some(([k]) => k === "provider:apiKey:brave"),
  },
  "POST /api/mcp-servers": {
    call: (l) => invoke(mcpServers.POST, evt("/api/mcp-servers", "POST", { name: "srv", server: MCP_SERVER }), l),
    arm: () => {},
    breached: () => h.installMcpExtension.mock.calls.length > 0,
  },
  "PUT /api/mcp-servers/:id": {
    call: (l) =>
      invoke(mcpServerId.PUT, evt("/api/mcp-servers/e1", "PUT", { server: MCP_SERVER }, { id: "e1" }), l),
    arm: () => {
      h.getExtension.mockResolvedValue({ id: "e1", name: "srv", manifest: { kind: "mcp", mcpServers: [MCP_SERVER] } });
    },
    breached: () => h.updateMcpExtension.mock.calls.length > 0,
  },
  "POST /api/mcp-servers/:id/refresh": {
    call: (l) => invoke(mcpRefresh.POST, evt("/api/mcp-servers/e1/refresh", "POST", undefined, { id: "e1" }), l),
    arm: () => {},
    breached: () => h.refreshMcpTools.mock.calls.length > 0,
  },
  "POST /api/providers/local/models": {
    call: (l) =>
      invoke(localModels.POST, evt("/api/providers/local/models", "POST", { baseUrl: "https://llm.example.com" }), l),
    arm: () => {},
    breached: () => h.listModels.mock.calls.length > 0,
  },
  "POST /api/providers/local/test": {
    call: (l) =>
      invoke(
        localTest.POST,
        evt("/api/providers/local/test", "POST", { baseUrl: "https://llm.example.com", modelId: "m" }),
        l,
      ),
    arm: () => {},
    breached: () => h.checkLocalModel.mock.calls.length > 0,
  },
  "POST /api/extensions/:id/modifiable": {
    call: (l) =>
      invoke(modifiable.POST, evt("/api/extensions/e1/modifiable", "POST", { modifiable: true }, { id: "e1" }), l),
    arm: () => {
      h.getExtension.mockResolvedValue({ id: "e1", name: "x", isBundled: false, modifiable: false });
      h.setExtensionModifiable.mockResolvedValue({ id: "e1", modifiable: true });
    },
    breached: () => h.setExtensionModifiable.mock.calls.length > 0,
  },

  // ── F6 second wave ───────────────────────────────────────────────────
  // Five handlers the first sweep left on the ROLE axis alone. Each one is
  // reachable by an admin-role key minted `--scopes read`, and each one either
  // spends an instance secret or hands out a privilege.
  "GET /api/settings": {
    call: (l) => invoke(settingsRoot.GET, evt("/api/settings", "GET"), l),
    arm: () => {},
    breached: () => h.getAllSettings.mock.calls.length > 0,
  },
  "GET /api/auth/invite": {
    call: (l) => invoke(invite.GET, evt("/api/auth/invite", "GET"), l),
    arm: () => {},
    breached: () => h.listInvites.mock.calls.length > 0,
  },
  "POST /api/auth/invite": {
    // The escalation this closes: `role` is part of the body, so an ungated
    // call mints an ADMIN invite — account creation with a privilege grant.
    call: (l) =>
      invoke(invite.POST, evt("/api/auth/invite", "POST", { email: "pwn@example.com", role: "admin" }), l),
    arm: () => {},
    breached: () => h.createInvite.mock.calls.length > 0,
  },
  "POST /api/providers/:provider/test": {
    call: (l) =>
      invoke(providerTest.POST, evt("/api/providers/openai/test", "POST", undefined, { provider: "openai" }), l),
    arm: () => {},
    // Reaching `getCredential` IS the breach: it decrypts the instance BYOK
    // key, and the handler then spends it on a live completion.
    breached: () => h.getCredential.mock.calls.length > 0,
  },
  "POST /api/providers/:provider/refresh-models": {
    call: (l) =>
      invoke(
        providerRefresh.POST,
        evt("/api/providers/openai/refresh-models", "POST", undefined, { provider: "openai" }),
        l,
      ),
    arm: () => {},
    // Overwrites `provider:discoveredModels:openai` — the list every routing
    // decision reads.
    breached: () => h.upsertSetting.mock.calls.some(([k]) => k === "provider:discoveredModels:openai"),
  },
};

const ROUTE_NAMES = Object.keys(ROUTES);

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
  h.getSetting.mockResolvedValue(undefined);
  h.deleteSetting.mockResolvedValue(true);
  h.getExtension.mockResolvedValue(null);
  h.mcpListTools.mockResolvedValue([]);
});

describe("F2 — admin routes enforce the SCOPE axis, not just ROLE", () => {
  // The suite is only meaningful if it actually covers every handler: the 11
  // the audit flagged, plus the 5 the F6 second wave found still on the role
  // axis alone (`GET /api/settings`, both `/api/auth/invite` methods, and the
  // two per-provider routes whose own comments already CLAIMED "BOTH axes"
  // while calling only `requireAdmin`).
  test("the table covers every handler the audit flagged", () => {
    expect(ROUTE_NAMES).toHaveLength(16);
  });

  test.each(ROUTE_NAMES)(
    "%s — admin-role key scoped ['read'] is refused 403 and performs NO write",
    async (name) => {
      const probe = ROUTES[name];
      probe.arm();
      const res = await probe.call(ADMIN_ROLE_READ_KEY);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string; required?: string };
      expect(body.error).toBe("Insufficient scope");
      expect(body.required).toBe("admin");
      // The whole point: the privileged operation never ran.
      expect(probe.breached()).toBe(false);
    },
  );

  test.each(ROUTE_NAMES)("%s — an admin COOKIE session still succeeds", async (name) => {
    const probe = ROUTES[name];
    probe.arm();
    const res = await probe.call(ADMIN_COOKIE);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(probe.breached()).toBe(true);
  });

  test.each(ROUTE_NAMES)("%s — a correctly-scoped admin key still succeeds", async (name) => {
    const probe = ROUTES[name];
    probe.arm();
    const res = await probe.call(ADMIN_SCOPED_KEY);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(probe.breached()).toBe(true);
  });

  test.each(ROUTE_NAMES)("%s — a non-admin member is still refused 403 (role axis)", async (name) => {
    const probe = ROUTES[name];
    probe.arm();
    const res = await probe.call(MEMBER_COOKIE);
    expect(res.status).toBe(403);
    expect(probe.breached()).toBe(false);
  });

  // F6: `requireRole` throws a raw Response, which SvelteKit renders as a
  // 500 rather than the intended 403. `checkRole` returns it instead.
  //
  // POST-MERGE NOTE: #84 swept these routes to `requireAdmin`, which also
  // returns, so the THROW half of this assertion is now guaranteed by main —
  // and additionally by main's static scan in `route-contract.test.ts`
  // ("no +server.ts throws its role-gate denial without converting it").
  // Measured: against the post-#84 baseline this test still fails, but at
  // `expect([401,403]).toContain(200)` — the SCOPE dimension — not at
  // `lastCallThrew`. It is kept as a runtime cross-check of the returned-shape
  // invariant that the static scan can only assert textually; the scope axis
  // is what it now discriminates.
  test.each(ROUTE_NAMES)("%s — denials are RETURNED, never thrown (403 not 500)", async (name) => {
    const probe = ROUTES[name];
    // Unauthenticated (401), wrong scope (403), wrong role (403) — every
    // denial must come back as a value. `invoke` records which style the
    // handler used in `lastCallThrew`.
    for (const locals of [{}, ADMIN_ROLE_READ_KEY, MEMBER_COOKIE]) {
      probe.arm();
      const res = await probe.call(locals);
      expect(res).toBeInstanceOf(Response);
      expect([401, 403]).toContain(res.status);
      expect(lastCallThrew).toBe(false);
    }
  });
});
