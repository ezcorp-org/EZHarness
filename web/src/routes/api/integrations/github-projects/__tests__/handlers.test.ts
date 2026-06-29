/**
 * Unit tests for the github-projects integration API route handlers.
 *
 * The GitHub client, the spawn bridge, the db-query layer, the host-only
 * secrets store (setSecret / deleteSecret), and the bus-registry are all mocked
 * so the tests are pure and laser-focused on each handler's auth/validation/
 * branch logic. We assert on concrete Response status codes + JSON bodies
 * (handlers return via errorJson() / json()), and we assert that NOTHING is
 * persisted when validation fails and that the plaintext token is never echoed.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  mockServerAlias,
  MEMBER_USER,
  createMockEvent,
} from "../../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

// Generated SvelteKit `$types` modules don't exist under bun:test — stub them.
for (const seg of ["connect", "link", "link/refresh-columns", "proposals", "proposals/[id]/approve", "proposals/[id]/dismiss"]) {
  mock.module(
    `../../../../../../../web/src/routes/api/integrations/github-projects/${seg}/$types`,
    () => ({}),
  );
}

// Real pass-through for the response/scope helpers — we inspect statuses.
import * as httpErrorsActual from "../../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);
mock.module("$lib/server/security/api-keys", () => ({
  // Default: scope allowed (cookie-style). Overridden per-test via setScope().
  requireScope: () => scopeResponse,
}));

// requireAuth real impl throws a 401 Response when no user — keep it real.
import * as middlewareActual from "../../../../../../../src/auth/middleware";
mock.module("$server/auth/middleware", () => middlewareActual);

// ── Mock state (reset per test) ─────────────────────────────────────────
let scopeResponse: Response | null = null;

let projectsById: Record<string, { id: string; name: string }> = {};
// Seeded links, keyed by an arbitrary slot (usually the projectId); the
// multi-board query layer (listLinksByProjectId / getLinkById) derives from the
// rows' OWN projectId/id, so a project can carry several boards under different
// slot keys.
let linkByProject: Record<string, any> = {};
/** All boards whose row.projectId matches `pid`. */
function linksByProject(pid: string): any[] {
  return Object.values(linkByProject).filter((l: any) => l?.projectId === pid);
}
// Per-board override-token presence, keyed by `apiToken:<linkId>` secret name.
let tokenOverrides: Record<string, boolean> = {};
let proposalsById: Record<string, any> = {};
// When true, the setSecret mock throws — exercises the connect handler's
// token-persist failure branch (→ 500, link NOT upserted).
let setSecretThrows = false;
// When true, updateLink returns null — exercises the refresh-columns handler's
// "link vanished mid-flight" branch (→ 404).
let updateLinkReturnsNull = false;

// Captured side effects. Each secrets-store call records its full scope coords
// so we can assert (extensionId, projectId, name[, value], userId).
const setSecretCalls: Array<{
  extensionId: string;
  projectId: string | null;
  name: string;
  value: string;
  userId: string | null | undefined;
}> = [];
const deleteSecretCalls: Array<{
  extensionId: string;
  projectId: string | null;
  name: string;
  userId: string | null | undefined;
}> = [];
const upsertLinkCalls: any[] = [];
const updateLinkCalls: Array<{ id: string; patch: any }> = [];
const setEnabledCalls: Array<{ id: string; enabled: boolean }> = [];
const deleteLinkCalls: string[] = [];
const cancelActiveCalls: string[] = [];
const approveCalls: Array<{ id: string; actor: any }> = [];
const dismissCalls: Array<{ id: string; userId: string }> = [];
const emitCalls: Array<{ event: string; payload: any }> = [];

// Client behaviour toggles.
let resolveBoardImpl: (url: string, auth: any) => Promise<any> = async () => ({
  boardNodeId: "PVT_board1",
  title: "Roadmap",
  ownerLogin: "acme",
  statusFieldId: "FIELD_status",
  statusOptions: [
    { id: "opt-todo", name: "Todo" },
    { id: "opt-doing", name: "Doing" },
  ],
});
let validateAuthImpl: (auth: any, boardNodeId: string) => Promise<any> = async () => ({
  ok: true,
  scopes: ["repo", "project"],
  missingScopes: [],
});
let approveImpl: (id: string, actor: any) => Promise<any> = async (id) => ({
  ...proposalsById[id],
  status: "spawned",
  conversationId: "conv-1",
  agentRunId: "run-1",
});
let dismissImpl: (id: string, userId: string) => Promise<any> = async (id) => ({
  ...proposalsById[id],
  status: "dismissed",
});

mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) => projectsById[id] ?? undefined,
}));

mock.module("$server/db/queries/github-projects", () => ({
  getLinkByProjectId: async (pid: string) => linksByProject(pid)[0] ?? null,
  getLinkById: async (id: string) =>
    Object.values(linkByProject).find((l: any) => l.id === id) ?? null,
  listLinksByProjectId: async (pid: string) => linksByProject(pid),
  getProposalById: async (id: string) => proposalsById[id] ?? null,
  upsertLink: async (input: any) => {
    upsertLinkCalls.push(input);
    const row = { id: "link-new", ...input, columnActionMap: {}, enabled: true, pollIntervalSec: 60, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    linkByProject[input.projectId] = row;
    return row;
  },
  updateLink: async (id: string, patch: any) => {
    updateLinkCalls.push({ id, patch });
    if (updateLinkReturnsNull) return null;
    const existing = Object.values(linkByProject).find((l: any) => l.id === id);
    if (!existing) return null;
    return { ...existing, ...patch };
  },
  setLinkEnabled: async (id: string, enabled: boolean) => {
    setEnabledCalls.push({ id, enabled });
    const existing = Object.values(linkByProject).find((l: any) => l.id === id);
    if (!existing) return null;
    return { ...existing, enabled };
  },
  deleteLink: async (id: string) => {
    deleteLinkCalls.push(id);
    // Drop the row so a subsequent listLinksByProjectId reflects the deletion
    // (the DELETE route reads it to decide whether to purge the shared token).
    for (const key of Object.keys(linkByProject)) {
      if (linkByProject[key]?.id === id) delete linkByProject[key];
    }
  },
  cancelActiveProposalsForLink: async (id: string) => {
    cancelActiveCalls.push(id);
    return 2;
  },
  listProposalsByProject: async (_pid: string, opts: any = {}) => {
    const all = Object.values(proposalsById);
    if (opts.statuses?.length) {
      return all.filter((p: any) => opts.statuses.includes(p.status));
    }
    return all;
  },
}));

mock.module("$server/integrations/github-projects/client", () => ({
  createGithubClient: () => ({
    resolveBoardFromUrl: (url: string, auth: any) => resolveBoardImpl(url, auth),
    validateAuth: (auth: any, boardNodeId: string) => validateAuthImpl(auth, boardNodeId),
  }),
}));

mock.module("$server/integrations/github-projects/spawn", () => ({
  approveProposal: async (id: string, actor: any) => {
    approveCalls.push({ id, actor });
    return approveImpl(id, actor);
  },
  dismissProposal: async (id: string, userId: string) => {
    dismissCalls.push({ id, userId });
    return dismissImpl(id, userId);
  },
}));

// Shared project token presence/value, for the connect route's "reuse existing
// shared token" path (a 2nd board with no typed token).
let sharedTokenByProject: Record<string, string | null> = {};
mock.module("$server/extensions/secrets-store", () => ({
  setSecret: async (
    extensionId: string,
    projectId: string | null,
    name: string,
    value: string,
    opts?: { userId?: string | null },
  ) => {
    if (setSecretThrows) throw new Error("secret write failed");
    setSecretCalls.push({ extensionId, projectId, name, value, userId: opts?.userId });
  },
  getSecret: async (_ext: string, projectId: string | null, name: string) =>
    name === "apiToken" ? (sharedTokenByProject[projectId ?? ""] ?? null) : null,
  hasSecret: async (_ext: string, _projectId: string | null, name: string) =>
    tokenOverrides[name] ?? false,
  deleteSecret: async (
    extensionId: string,
    projectId: string | null,
    name: string,
    opts?: { userId?: string | null },
  ) => {
    deleteSecretCalls.push({ extensionId, projectId, name, userId: opts?.userId });
    return true;
  },
}));

mock.module("$server/integrations/github-projects/bus-registry", () => ({
  getGithubProjectsEmit: () => (event: string, payload: any) => {
    emitCalls.push({ event, payload });
  },
}));

// Host-only credential resolver used by the refresh-columns route. Mocked so
// the handler test never touches the real secrets store or `gh` shell.
let resolveAuthThrows = false;
const resolveAuthCalls: any[] = [];
mock.module("$server/integrations/github-projects/auth", () => ({
  resolveLinkAuth: async (link: any) => {
    resolveAuthCalls.push(link);
    if (resolveAuthThrows) throw new Error("no PAT stored for board or project");
    return { mode: "pat", token: "ghp_resolved" };
  },
  boardTokenName: (linkId: string) => `apiToken:${linkId}`,
}));

// ── Import handlers AFTER mocks ─────────────────────────────────────────
const { POST: connect } = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/connect/+server"
);
const {
  GET: linkGet,
  PATCH: linkPatch,
  DELETE: linkDelete,
} = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/link/+server"
);
const { POST: refreshColumns } = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/link/refresh-columns/+server"
);
const { GET: proposalsList } = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/proposals/+server"
);
const { POST: approve } = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/proposals/[id]/approve/+server"
);
const { POST: dismiss } = await import(
  "../../../../../../../web/src/routes/api/integrations/github-projects/proposals/[id]/dismiss/+server"
);

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  scopeResponse = null;
  projectsById = { "proj-1": { id: "proj-1", name: "Proj One" } };
  linkByProject = {};
  tokenOverrides = {};
  sharedTokenByProject = {};
  proposalsById = {};
  setSecretThrows = false;
  updateLinkReturnsNull = false;
  setSecretCalls.length = 0;
  deleteSecretCalls.length = 0;
  upsertLinkCalls.length = 0;
  updateLinkCalls.length = 0;
  setEnabledCalls.length = 0;
  deleteLinkCalls.length = 0;
  cancelActiveCalls.length = 0;
  approveCalls.length = 0;
  dismissCalls.length = 0;
  emitCalls.length = 0;
  resolveAuthThrows = false;
  resolveAuthCalls.length = 0;
  resolveBoardImpl = async () => ({
    boardNodeId: "PVT_board1",
    title: "Roadmap",
    ownerLogin: "acme",
    statusFieldId: "FIELD_status",
    statusOptions: [
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ],
  });
  validateAuthImpl = async () => ({ ok: true, scopes: ["repo", "project"], missingScopes: [] });
  approveImpl = async (id) => ({
    ...proposalsById[id],
    status: "spawned",
    conversationId: "conv-1",
    agentRunId: "run-1",
  });
  dismissImpl = async (id) => ({ ...proposalsById[id], status: "dismissed" });
});

function ev(opts: { method?: string; body?: unknown; url?: string; params?: Record<string, string>; user?: typeof MEMBER_USER | null } = {}) {
  return createMockEvent({
    method: opts.method ?? "GET",
    url: opts.url ?? "http://localhost/api/integrations/github-projects",
    body: opts.body,
    params: opts.params,
    user: opts.user === null ? undefined : opts.user ?? MEMBER_USER,
  });
}

async function run(handler: any, event: any): Promise<Response> {
  try {
    return await handler(event);
  } catch (e) {
    return e as Response;
  }
}

// ════════════════════════ connect ════════════════════════
describe("POST connect", () => {
  test("happy path (pat): resolves, validates, stores token in secrets store, upserts link", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "https://github.com/orgs/acme/projects/7", authMode: "pat", token: "ghp_secret" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ boardTitle: "Roadmap", ownerLogin: "acme", scopes: ["repo", "project"] });
    expect(body.statusOptions).toHaveLength(2);
    // Token was stored via the secrets store at the right (project) scope, NOT
    // echoed. No userId → the PAT is project-scoped so the daemon can read it.
    expect(setSecretCalls).toHaveLength(1);
    expect(setSecretCalls[0]).toEqual({
      extensionId: "github-projects",
      projectId: "proj-1",
      name: "apiToken",
      value: "ghp_secret",
      userId: undefined,
    });
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
    expect(upsertLinkCalls).toHaveLength(1);
    expect(upsertLinkCalls[0].authMode).toBe("pat");
    expect(upsertLinkCalls[0].createdByUserId).toBe(MEMBER_USER.id);
  });

  test("passes an optional defaultModel through to upsertLink at connect time", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh", defaultModel: "openai:gpt-4o" } }));
    expect(res.status).toBe(200);
    expect(upsertLinkCalls[0].defaultModel).toBe("openai:gpt-4o");
  });

  test("connect without a defaultModel stores null (instance default)", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(200);
    expect(upsertLinkCalls[0].defaultModel).toBeNull();
  });

  test("rejects a malformed defaultModel (no colon) → 400, nothing persisted", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh", defaultModel: "noprovider" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("provider");
    // Validation runs BEFORE board resolution, so nothing is persisted.
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("passes an optional defaultPermissionMode through to upsertLink at connect time", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh", defaultPermissionMode: "ask" } }));
    expect(res.status).toBe(200);
    expect(upsertLinkCalls[0].defaultPermissionMode).toBe("ask");
  });

  test("connect without a defaultPermissionMode stores null (board 'yolo' fallback)", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(200);
    expect(upsertLinkCalls[0].defaultPermissionMode).toBeNull();
  });

  test("rejects an invalid defaultPermissionMode → 400 BEFORE any egress, nothing persisted", async () => {
    let resolved = false;
    resolveBoardImpl = async () => { resolved = true; return { boardNodeId: "PVT", title: "T", ownerLogin: "o", statusFieldId: "F", statusOptions: [] }; };
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh", defaultPermissionMode: "garbage" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("defaultPermissionMode");
    // Fast-fail: validation runs before board resolution → no egress, nothing persisted.
    expect(resolved).toBe(false);
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("gh mode: stores NO token, purges THIS board's stale override, upserts link", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(200);
    expect(setSecretCalls).toHaveLength(0);
    // Only this board's per-board override is purged (keyed by the new link id);
    // the SHARED project token is left alone — other boards may use it.
    expect(deleteSecretCalls).toHaveLength(1);
    expect(deleteSecretCalls[0]).toEqual({
      extensionId: "github-projects",
      projectId: "proj-1",
      name: "apiToken:link-new",
      userId: undefined,
    });
    expect(upsertLinkCalls[0].authMode).toBe("gh");
  });

  test("pat: a default-scope token is stored as the SHARED project token", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_secret" } }));
    expect(res.status).toBe(200);
    expect(setSecretCalls).toHaveLength(1);
    expect(setSecretCalls[0].name).toBe("apiToken");
    expect(setSecretCalls[0].value).toBe("ghp_secret");
  });

  test("pat + tokenScope 'board': stores a PER-BOARD override (apiToken:<linkId>), not the shared token", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_board", tokenScope: "board" } }));
    expect(res.status).toBe(200);
    expect(setSecretCalls).toHaveLength(1);
    expect(setSecretCalls[0].name).toBe("apiToken:link-new"); // the upsert mock's id
    expect(setSecretCalls[0].value).toBe("ghp_board");
  });

  test("pat + tokenScope 'board' WITHOUT a token → 400 (an override must carry a token)", async () => {
    sharedTokenByProject["proj-1"] = "ghp_existing_shared"; // present, but irrelevant for board scope
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", tokenScope: "board" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("per-board override");
    expect(upsertLinkCalls).toHaveLength(0);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("pat: a 2nd board with NO token reuses the existing shared token (validates, writes nothing new)", async () => {
    sharedTokenByProject["proj-1"] = "ghp_existing_shared";
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat" } }));
    expect(res.status).toBe(200);
    // The board is linked, but no NEW secret is written (it reuses the shared one).
    expect(upsertLinkCalls).toHaveLength(1);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("pat: no token AND no existing shared token → 400", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat" } }));
    expect(res.status).toBe(400);
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("rejects an invalid tokenScope → 400 (before any egress)", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "t", tokenScope: "global" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("tokenScope");
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("board-scope override persist fails on a FRESH board → 500 + the link is ROLLED BACK (no orphan)", async () => {
    // No board connected yet → this is a fresh INSERT. The override can't persist,
    // so the just-inserted link must be deleted (else it silently falls back to
    // the shared token, defeating the per-board isolation the user asked for).
    setSecretThrows = true;
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_board", tokenScope: "board" } }));
    expect(res.status).toBe(500);
    expect(upsertLinkCalls).toHaveLength(1);
    // The fresh link was rolled back — deleteLink was called for it, and no link
    // remains for the project.
    expect(deleteLinkCalls).toEqual(["link-new"]);
    expect(linkByProject["proj-1"]).toBeUndefined();
  });

  test("board-scope override persist fails on a PRE-EXISTING board → 500 but the board is NOT deleted", async () => {
    // The board (PVT_board1, what resolveBoardImpl returns) is already connected.
    // A failed re-connect must NOT destroy the previously-connected board.
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardNodeId: "PVT_board1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", statusFieldId: "F", statusOptions: [], defaultModel: null, authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    setSecretThrows = true;
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_board", tokenScope: "board" } }));
    expect(res.status).toBe(500);
    // A pre-existing board is never deleted by a failed re-connect.
    expect(deleteLinkCalls).toHaveLength(0);
  });

  test("missing user → 401, nothing persisted", async () => {
    const res = await run(connect, ev({ method: "POST", user: null, body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(401);
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("scope denied → that response is returned", async () => {
    scopeResponse = new Response(JSON.stringify({ error: "Insufficient scope" }), { status: 403 });
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(403);
  });

  test("invalid body → 400", async () => {
    const e = createMockEvent({ method: "POST", url: "http://localhost/x", user: MEMBER_USER });
    // Force a body that JSON.parse'd to null.
    (e as any).request = new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
    const res = await run(connect, e);
    expect(res.status).toBe(400);
  });

  test("missing boardUrl → 400", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", authMode: "gh" } }));
    expect(res.status).toBe(400);
  });

  test("invalid authMode → 400", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "oauth" } }));
    expect(res.status).toBe(400);
  });

  test("pat without token → 400", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat" } }));
    expect(res.status).toBe(400);
  });

  test("missing projectId → 400", async () => {
    const res = await run(connect, ev({ method: "POST", body: { boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(400);
  });

  test("unknown project → 404", async () => {
    const res = await run(connect, ev({ method: "POST", body: { projectId: "nope", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(404);
  });

  test("board resolve throws → 404, nothing persisted", async () => {
    resolveBoardImpl = async () => { throw new Error("bad url"); };
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(404);
    expect(upsertLinkCalls).toHaveLength(0);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("auth validation throws → 401, nothing persisted", async () => {
    validateAuthImpl = async () => { throw new Error("net"); };
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "t" } }));
    expect(res.status).toBe(401);
    expect(setSecretCalls).toHaveLength(0);
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("missing scopes → 403 with named scopes, nothing persisted", async () => {
    validateAuthImpl = async () => ({ ok: false, scopes: ["repo"], missingScopes: ["project"] });
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "t" } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.missingScopes).toEqual(["project"]);
    expect(setSecretCalls).toHaveLength(0);
    expect(upsertLinkCalls).toHaveLength(0);
  });

  test("token persist throws → 500 (link upserted first so an override can key off its id)", async () => {
    setSecretThrows = true;
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_secret" } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to store credentials");
    // The link is upserted BEFORE the token persist (a per-board override needs
    // the link id); the 500 lets the operator retry, and the board has a usable
    // credential as soon as a token is stored.
    expect(upsertLinkCalls).toHaveLength(1);
  });

  // ── canComment pass-through ──────────────────────────────────────────────

  test("happy path: canComment is forwarded from validation into the response (true when repo in scopes)", async () => {
    // validateAuthImpl default returns scopes: ["repo", "project"] — canComment should
    // be computed by the client and echoed by the connect handler.
    // We mock validateAuth to return a result that already includes canComment=true,
    // matching what the real client would compute for a classic PAT with "repo".
    validateAuthImpl = async () => ({ ok: true, scopes: ["repo", "project"], missingScopes: [], canComment: true });
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_secret" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canComment).toBe(true);
  });

  test("connect response canComment=false when validation indicates missing repo scope", async () => {
    validateAuthImpl = async () => ({ ok: true, scopes: ["read:org", "project"], missingScopes: [], canComment: false });
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "pat", token: "ghp_secret" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canComment).toBe(false);
  });

  test("connect response canComment=undefined when fine-grained PAT (no scope header)", async () => {
    validateAuthImpl = async () => ({ ok: true, scopes: [], missingScopes: [], canComment: undefined });
    const res = await run(connect, ev({ method: "POST", body: { projectId: "proj-1", boardUrl: "u", authMode: "gh" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // undefined becomes absent in JSON; the key won't exist or will be undefined.
    expect(body.canComment).toBeUndefined();
  });
});

// ════════════════════════ link GET ════════════════════════
describe("GET link", () => {
  test("returns an array of public link views (no token field), each with hasTokenOverride + defaultPermissionMode", async () => {
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", boardNodeId: "PVT", statusFieldId: "F", statusOptions: [], defaultModel: null, defaultPermissionMode: "auto-edit", authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    // This board carries a per-board override.
    tokenOverrides["apiToken:link-1"] = true;
    const res = await run(linkGet, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links).toHaveLength(1);
    expect(body.links[0].id).toBe("link-1");
    expect(body.links[0].hasTokenOverride).toBe(true);
    // publicLinkView surfaces the board's stored default permission mode.
    expect(body.links[0].defaultPermissionMode).toBe("auto-edit");
    expect(body.links[0]).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toMatch(/ENC\(|ghp_/);
  });

  test("publicLinkView exposes defaultPermissionMode as null when unset", async () => {
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", boardNodeId: "PVT", statusFieldId: "F", statusOptions: [], defaultModel: null, authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    const res = await run(linkGet, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect((await res.json()).links[0].defaultPermissionMode).toBeNull();
  });

  test("no links → empty array (200, not 404)", async () => {
    const res = await run(linkGet, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).links).toEqual([]);
  });

  test("hasTokenOverride is false when no per-board override is stored", async () => {
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", boardNodeId: "PVT", statusFieldId: "F", statusOptions: [], defaultModel: null, authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    const res = await run(linkGet, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect((await res.json()).links[0].hasTokenOverride).toBe(false);
  });

  test("missing projectId → 400", async () => {
    const res = await run(linkGet, ev({ url: "http://localhost/x" }));
    expect(res.status).toBe(400);
  });

  test("scope denied → 403", async () => {
    scopeResponse = new Response("{}", { status: 403 });
    const res = await run(linkGet, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect(res.status).toBe(403);
  });
});

// ════════════════════════ link PATCH ════════════════════════
describe("PATCH link", () => {
  beforeEach(() => {
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", boardNodeId: "PVT", statusFieldId: "F", authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
  });

  test("update columnActionMap (autoSpawn coerced + emit fires)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-doing": { action: "execute", autoSpawn: true, agentName: "coder", permissionMode: "acceptEdits" } } } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls).toHaveLength(1);
    expect(updateLinkCalls[0].patch.columnActionMap["opt-doing"]).toEqual({ action: "execute", autoSpawn: true, agentName: "coder", permissionMode: "acceptEdits" });
    expect(emitCalls).toHaveLength(1);
  });

  test("autoSpawn defaults OFF when omitted/non-true", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-todo": { action: "plan", autoSpawn: "yes" } } } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls[0].patch.columnActionMap["opt-todo"].autoSpawn).toBe(false);
  });

  test("accepts a valid defaultModel '<provider>:<model>'", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: "anthropic:claude-opus-4-20250514" } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls).toHaveLength(1);
    expect(updateLinkCalls[0].patch.defaultModel).toBe("anthropic:claude-opus-4-20250514");
  });

  test("accepts defaultModel null (→ clears to instance default)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: null } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls[0].patch.defaultModel).toBeNull();
  });

  test("accepts defaultModel '' (treated as null)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: "" } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls[0].patch.defaultModel).toBeNull();
  });

  test("rejects a malformed defaultModel (no colon) → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: "noprovider" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("provider");
  });

  test("rejects a defaultModel with an empty half → 400", async () => {
    const empties = ["anthropic:", ":model"];
    for (const v of empties) {
      updateLinkCalls.length = 0;
      const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: v } }));
      expect(res.status).toBe(400);
      expect(updateLinkCalls).toHaveLength(0);
    }
  });

  test("rejects a non-string, non-null defaultModel → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultModel: 42 } }));
    expect(res.status).toBe(400);
  });

  test("accepts a valid defaultPermissionMode ('yolo')", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultPermissionMode: "yolo" } }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls).toHaveLength(1);
    expect(updateLinkCalls[0].patch.defaultPermissionMode).toBe("yolo");
  });

  test("accepts defaultPermissionMode null + '' (clears to the board 'yolo' fallback)", async () => {
    for (const v of [null, ""]) {
      updateLinkCalls.length = 0;
      const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultPermissionMode: v } }));
      expect(res.status).toBe(200);
      expect(updateLinkCalls[0].patch.defaultPermissionMode).toBeNull();
    }
  });

  test("rejects an invalid defaultPermissionMode → 400, nothing updated", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultPermissionMode: "plan" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("defaultPermissionMode");
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("rejects a non-string defaultPermissionMode → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", defaultPermissionMode: 3 } }));
    expect(res.status).toBe(400);
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("pause via enabled:false uses setLinkEnabled", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", enabled: false } }));
    expect(res.status).toBe(200);
    expect(setEnabledCalls).toEqual([{ id: "link-1", enabled: false }]);
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("pollIntervalSec is clamped to the [15,3600] band", async () => {
    await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", pollIntervalSec: 2 } }));
    expect(updateLinkCalls[0].patch.pollIntervalSec).toBe(15);
    updateLinkCalls.length = 0;
    await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", pollIntervalSec: 99999 } }));
    expect(updateLinkCalls[0].patch.pollIntervalSec).toBe(3600);
  });

  test("invalid columnActionMap entry → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": { action: "delete" } } } }));
    expect(res.status).toBe(400);
  });

  test("columnActionMap not an object → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: [] } }));
    expect(res.status).toBe(400);
  });

  test("columnActionMap entry value is null → 400 (must be an object)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": null } } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be an object");
  });

  test("columnActionMap entry value is an array → 400 (must be an object)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": ["plan"] } } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be an object");
  });

  test("columnActionMap entry value is a primitive → 400 (must be an object)", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": "plan" } } }));
    expect(res.status).toBe(400);
  });

  test("non-numeric pollIntervalSec → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", pollIntervalSec: "soon" } }));
    expect(res.status).toBe(400);
  });

  test("non-boolean enabled → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", enabled: "off" } }));
    expect(res.status).toBe(400);
  });

  test("empty patch → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1" } }));
    expect(res.status).toBe(400);
  });

  test("invalid permissionMode → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": { action: "plan", permissionMode: "yolo" } } } }));
    expect(res.status).toBe(400);
  });

  test("non-string agentName → 400", async () => {
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", columnActionMap: { "opt-x": { action: "plan", agentName: 5 } } } }));
    expect(res.status).toBe(400);
  });

  // ── doneStatusOptionId ───────────────────────────────────────────────────

  test("valid doneStatusOptionId (member of statusOptions) is accepted and persisted", async () => {
    // Seed the link with known statusOptions so the validator has a membership set.
    linkByProject["proj-1"].statusOptions = [
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ];
    const res = await run(linkPatch, ev({
      method: "PATCH",
      body: {
        projectId: "proj-1",
        linkId: "link-1",
        columnActionMap: {
          "opt-todo": { action: "plan", autoSpawn: false, doneStatusOptionId: "opt-doing" },
        },
      },
    }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls).toHaveLength(1);
    expect(updateLinkCalls[0].patch.columnActionMap["opt-todo"].doneStatusOptionId).toBe("opt-doing");
  });

  test("invalid doneStatusOptionId (not a known option, statusOptions non-empty) → 400", async () => {
    linkByProject["proj-1"].statusOptions = [
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ];
    const res = await run(linkPatch, ev({
      method: "PATCH",
      body: {
        projectId: "proj-1",
        linkId: "link-1",
        columnActionMap: {
          "opt-todo": { action: "plan", autoSpawn: false, doneStatusOptionId: "opt-nope" },
        },
      },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("doneStatusOptionId");
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("legacy link with empty statusOptions accepts a free doneStatusOptionId string", async () => {
    // Legacy links have statusOptions=[] (never persisted). The validator must
    // skip the membership check so existing configs are not broken.
    linkByProject["proj-1"].statusOptions = [];
    const res = await run(linkPatch, ev({
      method: "PATCH",
      body: {
        projectId: "proj-1",
        linkId: "link-1",
        columnActionMap: {
          "opt-todo": { action: "plan", autoSpawn: false, doneStatusOptionId: "some-legacy-id" },
        },
      },
    }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls[0].patch.columnActionMap["opt-todo"].doneStatusOptionId).toBe("some-legacy-id");
  });

  test("empty-string doneStatusOptionId is silently omitted (no-op)", async () => {
    linkByProject["proj-1"].statusOptions = [{ id: "opt-todo", name: "Todo" }];
    const res = await run(linkPatch, ev({
      method: "PATCH",
      body: {
        projectId: "proj-1",
        linkId: "link-1",
        columnActionMap: {
          "opt-todo": { action: "plan", autoSpawn: false, doneStatusOptionId: "" },
        },
      },
    }));
    expect(res.status).toBe(200);
    expect(updateLinkCalls[0].patch.columnActionMap["opt-todo"]).not.toHaveProperty("doneStatusOptionId");
  });

  test("non-string doneStatusOptionId → 400", async () => {
    linkByProject["proj-1"].statusOptions = [{ id: "opt-todo", name: "Todo" }];
    const res = await run(linkPatch, ev({
      method: "PATCH",
      body: {
        projectId: "proj-1",
        linkId: "link-1",
        columnActionMap: {
          "opt-todo": { action: "plan", autoSpawn: false, doneStatusOptionId: 99 },
        },
      },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("doneStatusOptionId");
  });

  test("no link → 404", async () => {
    linkByProject = {};
    const res = await run(linkPatch, ev({ method: "PATCH", body: { projectId: "proj-1", linkId: "link-1", enabled: false } }));
    expect(res.status).toBe(404);
  });

  test("invalid body → 400", async () => {
    const e = createMockEvent({ method: "PATCH", url: "http://localhost/x", user: MEMBER_USER });
    (e as any).request = new Request("http://localhost/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "null" });
    const res = await run(linkPatch, e);
    expect(res.status).toBe(400);
  });
});

// ════════════════════════ link DELETE ════════════════════════
describe("DELETE link", () => {
  beforeEach(() => {
    linkByProject["proj-1"] = { id: "link-1", projectId: "proj-1", boardUrl: "u", boardTitle: "B", ownerLogin: "o", boardNodeId: "PVT", statusFieldId: "F", authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
  });

  test("disconnect (last board) purges the override + the shared token, cancels proposals, drops link, emits", async () => {
    // deleteLink (mocked) drops link-1 from linkByProject, so listLinksByProjectId
    // sees ZERO boards afterwards → the shared token is purged too.
    const res = await run(linkDelete, ev({ method: "DELETE", body: { projectId: "proj-1", linkId: "link-1" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ disconnected: true, cancelledProposals: 2 });
    // The per-board override is always purged; the shared token only because no
    // boards remain.
    expect(deleteSecretCalls).toEqual([
      { extensionId: "github-projects", projectId: "proj-1", name: "apiToken:link-1", userId: undefined },
      { extensionId: "github-projects", projectId: "proj-1", name: "apiToken", userId: undefined },
    ]);
    expect(cancelActiveCalls).toEqual(["link-1"]);
    expect(deleteLinkCalls).toEqual(["link-1"]);
    expect(emitCalls).toHaveLength(1);
  });

  test("disconnect (a board remains) purges ONLY this board's override, KEEPS the shared token", async () => {
    // A second board on the same project. deleteLink drops link-1 only, so
    // listLinksByProjectId still returns link-2 → the SHARED token is retained.
    linkByProject["proj-1b"] = { id: "link-2", projectId: "proj-1", boardUrl: "u2", boardTitle: "B2", ownerLogin: "o", boardNodeId: "PVT2", statusFieldId: "F", statusOptions: [], defaultModel: null, authMode: "pat", columnActionMap: {}, pollIntervalSec: 60, enabled: true, lastError: null, lastErrorAt: null, lastPolledAt: null, createdAt: new Date(0), updatedAt: new Date(0) };
    const res = await run(linkDelete, ev({ method: "DELETE", body: { projectId: "proj-1", linkId: "link-1" } }));
    expect(res.status).toBe(200);
    expect(deleteSecretCalls).toEqual([
      { extensionId: "github-projects", projectId: "proj-1", name: "apiToken:link-1", userId: undefined },
    ]);
  });

  test("wrong linkId → 404", async () => {
    const res = await run(linkDelete, ev({ method: "DELETE", body: { projectId: "proj-1", linkId: "nope" } }));
    expect(res.status).toBe(404);
    expect(deleteLinkCalls).toHaveLength(0);
  });

  test("missing linkId → 400", async () => {
    const res = await run(linkDelete, ev({ method: "DELETE", body: { projectId: "proj-1" } }));
    expect(res.status).toBe(400);
    expect(deleteLinkCalls).toHaveLength(0);
  });

  test("invalid body → 400", async () => {
    const e = createMockEvent({ method: "DELETE", url: "http://localhost/x", user: MEMBER_USER });
    (e as any).request = new Request("http://localhost/x", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "null" });
    const res = await run(linkDelete, e);
    expect(res.status).toBe(400);
  });

  test("missing projectId → 400", async () => {
    const res = await run(linkDelete, ev({ method: "DELETE", body: {} }));
    expect(res.status).toBe(400);
  });
});

// ════════════════════════ proposals list ════════════════════════
describe("GET proposals", () => {
  beforeEach(() => {
    proposalsById = {
      "p-pending": { id: "p-pending", projectId: "proj-1", linkId: "link-1", itemNodeId: "i1", statusOptionId: "o", statusName: "Doing", action: "plan", title: "T1", ticketUrl: null, status: "pending", conversationId: null, agentRunId: null, proposedAt: new Date(0), decidedAt: null, decidedByUserId: null, finishedAt: null, error: null },
      "p-done": { id: "p-done", projectId: "proj-1", linkId: "link-1", itemNodeId: "i2", statusOptionId: "o", statusName: "Doing", action: "plan", title: "T2", ticketUrl: null, status: "done", conversationId: "c", agentRunId: "r", proposedAt: new Date(0), decidedAt: new Date(0), decidedByUserId: "u", finishedAt: new Date(0), error: null },
    };
  });

  test("default: splits into active + history", async () => {
    const res = await run(proposalsList, ev({ url: "http://localhost/x?projectId=proj-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active.map((p: any) => p.id)).toEqual(["p-pending"]);
    expect(body.history.map((p: any) => p.id)).toEqual(["p-done"]);
  });

  test("status=active filter", async () => {
    const res = await run(proposalsList, ev({ url: "http://localhost/x?projectId=proj-1&status=active" }));
    const body = await res.json();
    expect(body.proposals.map((p: any) => p.id)).toEqual(["p-pending"]);
  });

  test("status=history filter", async () => {
    const res = await run(proposalsList, ev({ url: "http://localhost/x?projectId=proj-1&status=history" }));
    const body = await res.json();
    expect(body.proposals.map((p: any) => p.id)).toEqual(["p-done"]);
  });

  test("missing projectId → 400", async () => {
    const res = await run(proposalsList, ev({ url: "http://localhost/x" }));
    expect(res.status).toBe(400);
  });
});

// ════════════════════════ approve / dismiss ════════════════════════
describe("POST proposals/:id/approve", () => {
  beforeEach(() => {
    proposalsById = { "p1": { id: "p1", projectId: "proj-1", status: "pending", linkId: "l", itemNodeId: "i", statusOptionId: "o", statusName: "D", action: "plan", title: "T", ticketUrl: null, conversationId: null, agentRunId: null, proposedAt: new Date(0), decidedAt: null, decidedByUserId: null, finishedAt: null, error: null } };
  });

  test("approves a pending proposal, passes user actor, emits", async () => {
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(200);
    expect(approveCalls).toEqual([{ id: "p1", actor: { kind: "user", userId: MEMBER_USER.id } }]);
    const body = await res.json();
    expect(body.proposal.status).toBe("spawned");
    expect(emitCalls).toHaveLength(1);
  });

  test("missing proposal → 404 (ownership oracle: opaque)", async () => {
    const res = await run(approve, ev({ method: "POST", params: { id: "nope" } }));
    expect(res.status).toBe(404);
    expect(approveCalls).toHaveLength(0);
  });

  test("proposal in a deleted project → 404", async () => {
    proposalsById["p1"].projectId = "ghost";
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(404);
  });

  test("non-pending proposal → 409", async () => {
    proposalsById["p1"].status = "spawned";
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(409);
    expect(approveCalls).toHaveLength(0);
  });

  test("missing user → 401", async () => {
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" }, user: null }));
    expect(res.status).toBe(401);
  });

  test("missing :id param → 404", async () => {
    const res = await run(approve, ev({ method: "POST", params: {} }));
    expect(res.status).toBe(404);
  });

  test("spawn bridge throws → 500", async () => {
    approveImpl = async () => { throw new Error("spawn boom"); };
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(500);
  });

  test("scope denied → 403", async () => {
    scopeResponse = new Response("{}", { status: 403 });
    const res = await run(approve, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(403);
  });
});

describe("POST proposals/:id/dismiss", () => {
  beforeEach(() => {
    proposalsById = { "p1": { id: "p1", projectId: "proj-1", status: "pending", linkId: "l", itemNodeId: "i", statusOptionId: "o", statusName: "D", action: "plan", title: "T", ticketUrl: null, conversationId: null, agentRunId: null, proposedAt: new Date(0), decidedAt: null, decidedByUserId: null, finishedAt: null, error: null } };
  });

  test("dismisses a pending proposal, passes userId, emits", async () => {
    const res = await run(dismiss, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(200);
    expect(dismissCalls).toEqual([{ id: "p1", userId: MEMBER_USER.id }]);
    const body = await res.json();
    expect(body.proposal.status).toBe("dismissed");
    expect(emitCalls).toHaveLength(1);
  });

  test("missing proposal → 404", async () => {
    const res = await run(dismiss, ev({ method: "POST", params: { id: "nope" } }));
    expect(res.status).toBe(404);
    expect(dismissCalls).toHaveLength(0);
  });

  test("non-pending → 409", async () => {
    proposalsById["p1"].status = "dismissed";
    const res = await run(dismiss, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(409);
  });

  test("dismiss bridge throws → 500", async () => {
    dismissImpl = async () => { throw new Error("boom"); };
    const res = await run(dismiss, ev({ method: "POST", params: { id: "p1" } }));
    expect(res.status).toBe(500);
  });

  test("missing user → 401", async () => {
    const res = await run(dismiss, ev({ method: "POST", params: { id: "p1" }, user: null }));
    expect(res.status).toBe(401);
  });
});

// ════════════════════════ link/refresh-columns ════════════════════════
describe("POST link/refresh-columns", () => {
  // Seed a connected link whose columns were never persisted (status_options
  // = []), mirroring the legacy-link bug the route self-heals.
  function seedEmptyLink(overrides: Record<string, unknown> = {}) {
    linkByProject["proj-1"] = {
      id: "link-1",
      projectId: "proj-1",
      boardUrl: "https://github.com/orgs/acme/projects/7",
      boardTitle: "Roadmap",
      ownerLogin: "acme",
      boardNodeId: "PVT_board1",
      statusFieldId: null,
      statusOptions: [],
      defaultModel: null,
      authMode: "pat",
      columnActionMap: { "opt-doing": { action: "plan", autoSpawn: false } },
      pollIntervalSec: 60,
      enabled: true,
      lastPolledAt: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    };
  }

  function body(projectId: unknown = "proj-1", linkId: unknown = "link-1") {
    return { method: "POST", body: { projectId, linkId } };
  }

  test("happy path: resolves the host credential, re-fetches the board, persists named columns", async () => {
    seedEmptyLink();
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    // The board's COMPLETE column set (id+name) is now on the link.
    expect(json.link.statusOptions).toEqual([
      { id: "opt-todo", name: "Todo" },
      { id: "opt-doing", name: "Doing" },
    ]);
    // Credential was resolved host-side (never accepted from the client).
    expect(resolveAuthCalls).toHaveLength(1);
    expect(resolveAuthCalls[0].id).toBe("link-1");
    // Persisted via updateLink with BOTH the options and the resolved field id.
    expect(updateLinkCalls).toHaveLength(1);
    expect(updateLinkCalls[0].id).toBe("link-1");
    expect(updateLinkCalls[0].patch.statusOptions).toHaveLength(2);
    expect(updateLinkCalls[0].patch.statusFieldId).toBe("FIELD_status");
  });

  test("gh-mode link: the route is auth-mode agnostic (resolver handles it) → 200", async () => {
    seedEmptyLink({ authMode: "gh" });
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(200);
    expect(resolveAuthCalls[0].authMode).toBe("gh");
  });

  test("credential resolve fails → 401, link left untouched (no updateLink)", async () => {
    seedEmptyLink();
    resolveAuthThrows = true;
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(401);
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("board re-resolve fails (GitHub error) → 502, link left untouched (no updateLink)", async () => {
    seedEmptyLink();
    resolveBoardImpl = async () => {
      throw new Error("rate limited");
    };
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(502);
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("updateLink returns null (link vanished mid-flight) → 404", async () => {
    seedEmptyLink();
    updateLinkReturnsNull = true; // simulate the row disappearing before the write
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(404);
  });

  test("missing projectId → 400", async () => {
    const res = await run(refreshColumns, ev({ method: "POST", body: {} }));
    expect(res.status).toBe(400);
  });

  test("unknown project → 404", async () => {
    const res = await run(refreshColumns, ev(body("nope")));
    expect(res.status).toBe(404);
  });

  test("no link for the linkId → 404", async () => {
    // project exists but no link seeded under that id.
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(404);
  });

  test("missing linkId → 400", async () => {
    const res = await run(refreshColumns, ev({ method: "POST", body: { projectId: "proj-1" } }));
    expect(res.status).toBe(400);
  });

  test("linkId for another project → opaque 404", async () => {
    seedEmptyLink({ projectId: "other-project" });
    const res = await run(refreshColumns, ev(body("proj-1", "link-1")));
    expect(res.status).toBe(404);
    expect(updateLinkCalls).toHaveLength(0);
  });

  test("invalid body → 400", async () => {
    const e = createMockEvent({ method: "POST", url: "http://localhost/x", user: MEMBER_USER });
    (e as any).request = new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
    const res = await run(refreshColumns, e);
    expect(res.status).toBe(400);
  });

  test("scope denied → that response is returned", async () => {
    seedEmptyLink();
    scopeResponse = new Response(JSON.stringify({ error: "Insufficient scope" }), { status: 403 });
    const res = await run(refreshColumns, ev(body()));
    expect(res.status).toBe(403);
  });

  test("missing user → 401", async () => {
    seedEmptyLink();
    const res = await run(refreshColumns, ev({ method: "POST", body: { projectId: "proj-1" }, user: null }));
    expect(res.status).toBe(401);
  });
});
