// Unit + integration tests for src/extensions/github-projects-handler.ts.
//
// Unit: mock the GitHub client, the spawn bridge, the DB queries,
// getConversation, the secrets store (getSecret), and the links-by-user seam. Covers
// every verb, server-side projectId derivation, the "no board connected" path,
// the confused-deputy guard (a board id in params is ignored), ownership checks
// on control verbs, and the bundled-only allowlist (non-bundled caller
// rejected).
//
// Integration: real PGlite + real queries + mocked client/spawn — proves a
// ticket verb resolves the link by the conversation's projectId, and a control
// verb mutates the right row.

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getTestPglite } from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type {
  GithubBoardItem,
  GithubClient,
  GithubFetchPage,
  GithubTicketRef,
} from "../../integrations/github-projects/types";
import type {
  GithubProjectsLink,
  GithubProjectsProposal,
} from "../../db/schema";

// ── DB connection → test PGlite (used by the integration block + the
//    handler's lazy default links-by-user query). The unit block overrides the
//    query layer entirely via mock.module below, so this is harmless there. ──
mock.module("../../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

// ── Mocked collaborators (unit) ──────────────────────────────────────
// These are mock.module'd so the handler's STATIC imports resolve to stubs.
// Each test sets the per-call behavior via the `*Impl` variables.

let getConversationImpl: (id: string) => Promise<{ projectId: string | null } | null> =
  async () => ({ projectId: "proj-1" });
mock.module("../../db/queries/conversations", () => ({
  getConversation: (id: string) => getConversationImpl(id),
}));

// The secrets store is host-only; the handler's `resolveAuth` delegates to
// the shared `resolveLinkAuth`, which reads the PAT from it via
// `getSecret("github-projects", projectId, name)`.
let getSecretImpl: (
  extensionId: string,
  projectId: string | null,
  name: string,
) => Promise<string | null> = async () => "ghp_token";
mock.module("../secrets-store", () => ({
  getSecret: (extensionId: string, projectId: string | null, name: string) =>
    getSecretImpl(extensionId, projectId, name),
}));

// Acting-user lookup for the RBAC checks (getUserById). Default: every id is
// a MEMBER row — combined with the allow-all hasExtensionScope stub below,
// this keeps the pre-RBAC cases valid ("member with all scopes granted").
// `../../db/queries/users` IS in mock-cleanup's MODULE_PATHS, so afterAll's
// restoreModuleMocks() re-registers the real module.
const REAL_USERS = { ...(await import("../../db/queries/users")) };
let getUserByIdImpl: (
  id: string,
) => Promise<{ id: string; role: "admin" | "member" } | undefined> = async (id) => ({
  id,
  role: "member",
});
mock.module("../../db/queries/users", () => ({
  ...REAL_USERS,
  getUserById: (id: string) => getUserByIdImpl(id),
}));

// Extension RBAC — in-file restore pattern (NOT in MODULE_PATHS): snapshot the
// real exports, stub hasExtensionScope with a programmable impl (default:
// every scope granted), re-register the real module in afterAll.
const REAL_RBAC = { ...(await import("../../auth/extension-rbac")) };
let hasScopeImpl: (
  user: { id: string; role: "admin" | "member" },
  q: { projectId: string | null; extensionId: string | null; scope: string },
) => Promise<boolean> = async () => true;
const rbacCalls: Array<{
  userId: string;
  role: string;
  projectId: string | null;
  extensionId: string | null;
  scope: string;
}> = [];
mock.module("../../auth/extension-rbac", () => ({
  ...REAL_RBAC,
  hasExtensionScope: (
    user: { id: string; role: "admin" | "member" },
    q: { projectId: string | null; extensionId: string | null; scope: string },
  ) => {
    rbacCalls.push({ userId: user.id, role: user.role, ...q });
    return hasScopeImpl(user, q);
  },
}));

let auditRows: Array<{ userId: string | null; action: string; target?: string; metadata?: unknown }> =
  [];
mock.module("../../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: unknown,
  ) => {
    auditRows.push({ userId, action, target, metadata });
    return "audit-1";
  },
}));

// In-file restore pattern (mock-cleanup-coverage): the github-projects client,
// spawn bridge, and query modules are NOT in mock-cleanup's MODULE_PATHS, so we
// snapshot the REAL exports BEFORE stubbing and re-register them in afterAll.
// This both satisfies the meta-test's "mocked twice ⇒ in-file restore" rule AND
// prevents these stubs from leaking into the sibling integration test file.
const REAL_CLIENT = { ...(await import("../../integrations/github-projects/client")) };
const REAL_SPAWN = { ...(await import("../../integrations/github-projects/spawn")) };
const REAL_QUERIES = { ...(await import("../../db/queries/github-projects")) };
const REAL_DAEMON = { ...(await import("../../integrations/github-projects/daemon")) };

// GitHub client — a programmable fake.
const clientCalls: Array<{ method: string; args: unknown[] }> = [];
let fakeClient: GithubClient;
mock.module("../../integrations/github-projects/client", () => ({
  createGithubClient: () => fakeClient,
}));

// Daemon — poll-now reverse-RPC forces an immediate poll of the SPECIFIC board
// via the singleton. Mock the factory so the handler reaches a programmable
// `pollLinkNow` without constructing the real poller. Snapshotted into
// REAL_DAEMON above and re-registered in afterAll (the in-file restore pattern,
// mirroring the client/spawn/query stubs) so the stub never leaks into the
// integration test file.
let pollLinkNowImpl: (link: GithubProjectsLink) => Promise<{ polled: boolean; reason?: string }> =
  async () => ({ polled: true });
const daemonCalls: Array<{ method: string; args: unknown[] }> = [];
mock.module("../../integrations/github-projects/daemon", () => ({
  getGithubProjectsDaemon: () => ({
    pollLinkNow: (link: GithubProjectsLink) => {
      daemonCalls.push({ method: "pollLinkNow", args: [link] });
      return pollLinkNowImpl(link);
    },
  }),
}));

// Spawn bridge. The two rerun error classes are re-declared here with the
// SAME shapes so the handler's `instanceof` mapping is drivable from the stub
// (the mocked module supplies the class objects the handler imports).
class GithubProposalNotRerunnableError extends Error {
  constructor(status: string) {
    super(`Proposal is not re-runnable (status: ${status})`);
  }
}
class GithubCardBusyError extends Error {
  constructor() {
    super("Card already has an active proposal");
  }
}
let approveImpl: (id: string, actor: unknown) => Promise<GithubProjectsProposal> = async (id) =>
  ({ id, status: "spawned" } as GithubProjectsProposal);
let dismissImpl: (id: string, userId: string) => Promise<GithubProjectsProposal> = async (id) =>
  ({ id, status: "dismissed" } as GithubProjectsProposal);
let rerunImpl: (id: string, actor: unknown) => Promise<GithubProjectsProposal> = async () =>
  ({ id: "prop-new", projectId: "proj-1", status: "pending" } as GithubProjectsProposal);
const spawnCalls: Array<{ method: string; args: unknown[] }> = [];
mock.module("../../integrations/github-projects/spawn", () => ({
  GithubProposalNotRerunnableError,
  GithubCardBusyError,
  approveProposal: (id: string, actor: unknown) => {
    spawnCalls.push({ method: "approve", args: [id, actor] });
    return approveImpl(id, actor);
  },
  dismissProposal: (id: string, userId: string) => {
    spawnCalls.push({ method: "dismiss", args: [id, userId] });
    return dismissImpl(id, userId);
  },
  rerunProposal: (id: string, actor: unknown) => {
    spawnCalls.push({ method: "rerun", args: [id, actor] });
    return rerunImpl(id, actor);
  },
}));

// DB queries — overridden per test in the unit block.
let getLinkByProjectIdImpl: (p: string) => Promise<GithubProjectsLink | null> = async () => null;
let getLinkByIdImpl: (id: string) => Promise<GithubProjectsLink | null> = async () => null;
let listLinksByProjectIdImpl: (p: string) => Promise<GithubProjectsLink[]> = async () => [];
let getProposalByIdImpl: (id: string) => Promise<GithubProjectsProposal | null> = async () => null;
let getProposalByConversationIdImpl: (c: string) => Promise<GithubProjectsProposal | null> =
  async () => null;
let listProposalsByProjectImpl: (
  p: string,
  opts?: unknown,
) => Promise<GithubProjectsProposal[]> = async () => [];
let setLinkEnabledImpl: (id: string, enabled: boolean) => Promise<GithubProjectsLink | null> =
  async () => null;
const queryCalls: Array<{ method: string; args: unknown[] }> = [];
mock.module("../../db/queries/github-projects", () => ({
  getLinkByProjectId: (p: string) => {
    queryCalls.push({ method: "getLinkByProjectId", args: [p] });
    return getLinkByProjectIdImpl(p);
  },
  getLinkById: (id: string) => {
    queryCalls.push({ method: "getLinkById", args: [id] });
    return getLinkByIdImpl(id);
  },
  listLinksByProjectId: (p: string) => {
    queryCalls.push({ method: "listLinksByProjectId", args: [p] });
    return listLinksByProjectIdImpl(p);
  },
  getProposalById: (id: string) => getProposalByIdImpl(id),
  getProposalByConversationId: (c: string) => {
    queryCalls.push({ method: "getProposalByConversationId", args: [c] });
    return getProposalByConversationIdImpl(c);
  },
  listProposalsByProject: (p: string, opts?: unknown) => listProposalsByProjectImpl(p, opts),
  setLinkEnabled: (id: string, enabled: boolean) => {
    queryCalls.push({ method: "setLinkEnabled", args: [id, enabled] });
    return setLinkEnabledImpl(id, enabled);
  },
}));

// Import AFTER the mocks are registered.
const {
  handleGithubProjectsRpc,
  resolveAuth,
  runGhAuthToken,
  BUNDLED_GITHUB_PROJECTS_ALLOWLIST,
  _setGhTokenResolverForTests,
  _setLinksByUserForTests,
} = await import("../github-projects-handler");
const { GITHUB_PROJECTS_RPC_PREFIX, GITHUB_PROJECTS_EVENT } = await import(
  "../../integrations/github-projects/types"
);
// The handler emits the proposal-update event through the REAL bus-registry
// (a plain registration slot — no mock.module needed): install a recorder.
const { registerGithubProjectsEmit, _resetGithubProjectsEmitForTests } = await import(
  "../../integrations/github-projects/bus-registry"
);
let emitCalls: Array<{ event: string; payload: unknown }> = [];

afterAll(() => {
  // Re-register the REAL github-projects modules so their stubs don't leak into
  // subsequent test files (the in-file restore pattern — a SECOND mock.module
  // per path, which is what mock-cleanup-coverage's walker recognizes).
  mock.module("../../integrations/github-projects/client", () => REAL_CLIENT);
  mock.module("../../integrations/github-projects/spawn", () => REAL_SPAWN);
  mock.module("../../db/queries/github-projects", () => REAL_QUERIES);
  mock.module("../../integrations/github-projects/daemon", () => REAL_DAEMON);
  mock.module("../../auth/extension-rbac", () => REAL_RBAC);
  restoreModuleMocks();
});

// ── Fixtures ─────────────────────────────────────────────────────────

function link(overrides: Partial<GithubProjectsLink> = {}): GithubProjectsLink {
  return {
    id: "link-1",
    projectId: "proj-1",
    boardNodeId: "PVT_board1",
    boardUrl: "https://github.com/orgs/acme/projects/1",
    boardTitle: "Roadmap",
    ownerLogin: "acme",
    statusFieldId: "FIELD_status",
    defaultModel: null,
    authMode: "pat",
    columnActionMap: {},
    pollCursor: null,
    pollIntervalSec: 60,
    enabled: true,
    lastPolledAt: new Date("2026-06-20T10:00:00Z"),
    lastError: null,
    lastErrorAt: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-20T10:00:00Z"),
    ...overrides,
  } as GithubProjectsLink;
}

function proposal(overrides: Partial<GithubProjectsProposal> = {}): GithubProjectsProposal {
  return {
    id: "prop-1",
    projectId: "proj-1",
    linkId: "link-1",
    itemNodeId: "PVTI_item1",
    contentNodeId: "I_issue1",
    statusOptionId: "opt-progress",
    statusName: "In Progress",
    action: "execute",
    title: "Ship the thing",
    ticketUrl: "https://github.com/acme/repo/issues/9",
    dedupeKey: "proj-1:PVTI_item1:opt-progress:execute",
    status: "pending",
    conversationId: null,
    agentRunId: null,
    proposedAt: new Date("2026-06-21T08:00:00Z"),
    decidedAt: null,
    decidedByUserId: null,
    finishedAt: null,
    error: null,
    createdAt: new Date("2026-06-21T08:00:00Z"),
    ...overrides,
  } as GithubProjectsProposal;
}

function boardItem(overrides: Partial<GithubBoardItem> = {}): GithubBoardItem {
  return {
    itemNodeId: "PVTI_item1",
    contentNodeId: "I_issue1",
    title: "Ship the thing",
    url: "https://github.com/acme/repo/issues/9",
    statusOptionId: "opt-progress",
    statusName: "In Progress",
    updatedAt: "2026-06-21T08:00:00Z",
    ...overrides,
  };
}

function makeClient(over: Partial<GithubClient> = {}): GithubClient {
  const noop = async () => undefined as never;
  return {
    resolveBoardFromUrl: async () => ({
      boardNodeId: "PVT_board1",
      title: "Roadmap",
      ownerLogin: "acme",
      statusFieldId: "FIELD_status",
      statusOptions: [
        { id: "opt-todo", name: "Todo" },
        { id: "opt-progress", name: "In Progress" },
        { id: "opt-done", name: "Done" },
      ],
    }),
    validateAuth: async () => ({ ok: true, scopes: [], missingScopes: [] }),
    fetchBoardItems: async (): Promise<GithubFetchPage> => ({
      items: [boardItem()],
      cursor: {},
    }),
    createIssueOnBoard: async (): Promise<GithubTicketRef> => ({
      itemNodeId: "PVTI_new",
      contentNodeId: null,
      url: null,
      title: "New",
    }),
    updateItem: async (): Promise<GithubTicketRef> => ({
      itemNodeId: "PVTI_item1",
      contentNodeId: "I_issue1",
      url: "https://github.com/acme/repo/issues/9",
      title: "Updated",
    }),
    setItemStatus: noop,
    archiveItem: noop,
    addComment: noop,
    ...over,
  };
}

function req(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id: 1, method, params };
}

function ctx(over: Partial<Parameters<typeof handleGithubProjectsRpc>[2]> = {}) {
  return {
    extensionName: "github-projects",
    extensionId: "ext-gp",
    userId: "user-1",
    conversationId: "conv-1",
    grantedPermissions: { grantedAt: {} },
    ...over,
  };
}

const V = (verb: string) => `${GITHUB_PROJECTS_RPC_PREFIX}${verb}`;

beforeEach(() => {
  clientCalls.length = 0;
  spawnCalls.length = 0;
  queryCalls.length = 0;
  daemonCalls.length = 0;
  pollLinkNowImpl = async () => ({ polled: true });
  getUserByIdImpl = async (id) => ({ id, role: "member" });
  hasScopeImpl = async () => true;
  rbacCalls.length = 0;
  auditRows = [];
  fakeClient = makeClient();
  getConversationImpl = async () => ({ projectId: "proj-1" });
  getSecretImpl = async () => "ghp_token";
  getLinkByProjectIdImpl = async () => link();
  getLinkByIdImpl = async () => link();
  // Default board derivation: no spawning proposal, exactly ONE board → the
  // single-board fallback resolves it (the common human-chat case).
  getProposalByConversationIdImpl = async () => null;
  listLinksByProjectIdImpl = async () => [link()];
  getProposalByIdImpl = async () => proposal();
  listProposalsByProjectImpl = async () => [proposal()];
  setLinkEnabledImpl = async () => link({ enabled: false });
  approveImpl = async (id) => ({ id, status: "spawned" } as GithubProjectsProposal);
  dismissImpl = async (id) => ({ id, status: "dismissed" } as GithubProjectsProposal);
  rerunImpl = async () =>
    ({ id: "prop-new", projectId: "proj-1", status: "pending" } as GithubProjectsProposal);
  emitCalls = [];
  registerGithubProjectsEmit((event, payload) => {
    emitCalls.push({ event, payload });
  });
  _setLinksByUserForTests(async () => [link()]);
  _setGhTokenResolverForTests(async () => "gh-cli-token");
});

afterEach(() => {
  _resetGithubProjectsEmitForTests();
  _setLinksByUserForTests(null);
  _setGhTokenResolverForTests(null);
});

// ── Bundled-only allowlist ───────────────────────────────────────────

describe("bundled-only allowlist", () => {
  test("allowlist contains github-projects only", () => {
    expect(BUNDLED_GITHUB_PROJECTS_ALLOWLIST.has("github-projects")).toBe(true);
    expect(BUNDLED_GITHUB_PROJECTS_ALLOWLIST.has("evil-lookalike")).toBe(false);
  });

  test("rejects a non-bundled caller by name (-32603)", async () => {
    const res = await handleGithubProjectsRpc(
      "list",
      req(V("list")),
      ctx({ extensionName: "evil-lookalike" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    // No DB / network touched.
    expect(queryCalls.length).toBe(0);
  });
});

// ── Ticket verbs: server-side projectId derivation + no board ────────

describe("ticket verbs — projectId derivation", () => {
  test("list derives projectId from the conversation, not from params", async () => {
    // A forged board id in params MUST be ignored — the handler uses the
    // conversation's projectId only. With no spawning proposal the single-board
    // fallback resolves the board via listLinksByProjectId(projectId).
    getConversationImpl = async (id) => {
      expect(id).toBe("conv-1");
      return { projectId: "proj-real" };
    };
    let seenProject = "";
    listLinksByProjectIdImpl = async (p) => {
      seenProject = p;
      return [link({ projectId: p })];
    };
    const res = await handleGithubProjectsRpc(
      "list",
      req(V("list"), { projectId: "proj-FORGED", boardId: "PVT_evil", linkId: "link-evil" }),
      ctx(),
    );
    expect(seenProject).toBe("proj-real");
    expect("result" in res).toBe(true);
  });

  test("returns a clear error when no board is connected", async () => {
    listLinksByProjectIdImpl = async () => [];
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("No GitHub Projects board");
  });

  test("returns an error when the conversation has no project", async () => {
    getConversationImpl = async () => ({ projectId: null });
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("No project scope");
  });

  test("returns an error when conversationId is unbound", async () => {
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx({ conversationId: null }));
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("multi-board: the SPAWNING proposal pins which board the verbs use", async () => {
    // Two boards on the project; the conversation was spawned from a proposal
    // owning link-B → the verbs must target link-B (never the first board).
    getProposalByConversationIdImpl = async (c) => {
      expect(c).toBe("conv-1");
      return proposal({ linkId: "link-B", projectId: "proj-1" });
    };
    let resolvedById = "";
    getLinkByIdImpl = async (id) => {
      resolvedById = id;
      return link({ id, projectId: "proj-1", boardNodeId: "PVT_B" });
    };
    // listLinks would resolve link-A first — proving the proposal wins, not the
    // fallback.
    listLinksByProjectIdImpl = async () => [
      link({ id: "link-A" }),
      link({ id: "link-B" }),
    ];
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect(resolvedById).toBe("link-B");
    expect("result" in res).toBe(true);
  });

  test("multi-board: ambiguous (many boards, no spawning proposal) → -32602", async () => {
    getProposalByConversationIdImpl = async () => null;
    listLinksByProjectIdImpl = async () => [link({ id: "link-A" }), link({ id: "link-B" })];
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("multiple GitHub boards");
  });

  test("multi-board: a proposal pointing at a DIFFERENT project's board is ignored (falls back)", async () => {
    // A proposal whose link belongs to another project must not be trusted —
    // the single-board fallback resolves the conversation's own board instead.
    getProposalByConversationIdImpl = async () => proposal({ linkId: "link-other" });
    getLinkByIdImpl = async () => link({ id: "link-other", projectId: "proj-OTHER" });
    listLinksByProjectIdImpl = async () => [link({ id: "link-own", projectId: "proj-1" })];
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("result" in res).toBe(true);
  });
});

// ── Auth resolution ──────────────────────────────────────────────────

describe("resolveAuth", () => {
  test("pat mode falls back to the SHARED project token when no per-board override", async () => {
    getSecretImpl = async (extensionId, projectId, name) => {
      expect(extensionId).toBe("github-projects");
      expect(projectId).toBe("proj-1");
      // Override (apiToken:link-1) → null; shared apiToken → the bearer.
      return name === "apiToken" ? "ghp_decoded" : null;
    };
    const auth = await resolveAuth(link({ authMode: "pat" }));
    expect(auth).toEqual({ mode: "pat", token: "ghp_decoded" });
  });

  test("pat mode prefers a per-board override (apiToken:<linkId>) over the shared token", async () => {
    getSecretImpl = async (_extensionId, _projectId, name) =>
      name === "apiToken:link-1" ? "ghp_board" : "ghp_shared";
    const auth = await resolveAuth(link({ authMode: "pat" }));
    expect(auth).toEqual({ mode: "pat", token: "ghp_board" });
  });

  test("pat mode throws a clear error when the store returns null", async () => {
    // The store returns null for a missing OR undecryptable secret — both
    // surface via the shared resolver's canonical `GithubAuthError` message
    // (the same one the web connect/refresh routes show the operator).
    getSecretImpl = async () => null;
    await expect(resolveAuth(link({ authMode: "pat" }))).rejects.toThrow(/no PAT stored/);
  });

  test("gh mode shells out to gh auth token", async () => {
    _setGhTokenResolverForTests(async () => "gho_clitoken");
    const auth = await resolveAuth(link({ authMode: "gh" }));
    expect(auth).toEqual({ mode: "gh", token: "gho_clitoken" });
  });

  test("the default gh resolver spawns `gh auth token` (success path)", async () => {
    // Reset to the REAL default resolver and stub Bun.spawn so no real `gh`
    // binary is needed — exercises `defaultGhTokenResolver`'s spawn closure.
    _setGhTokenResolverForTests(null);
    const spy = spyOn(Bun, "spawn").mockReturnValue({
      stdout: new Response("  ghp_default\n").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
    } as unknown as ReturnType<typeof Bun.spawn>);
    try {
      const auth = await resolveAuth(link({ authMode: "gh" }));
      expect(auth).toEqual({ mode: "gh", token: "ghp_default" });
      expect(spy.mock.calls[0]![0]).toEqual(["gh", "auth", "token"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("runGhAuthToken returns the trimmed token on exit 0", async () => {
    const token = await runGhAuthToken(() => ({
      stdout: new Response(" tok123 \n").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
    }));
    expect(token).toBe("tok123");
  });

  test("runGhAuthToken throws on a non-zero exit (with stderr)", async () => {
    await expect(
      runGhAuthToken(() => ({
        stdout: new Response("").body!,
        stderr: new Response("not logged in").body!,
        exited: Promise.resolve(1),
      })),
    ).rejects.toThrow(/not logged in/);
  });

  test("runGhAuthToken throws on empty output (exit 0 but no token)", async () => {
    await expect(
      runGhAuthToken(() => ({
        stdout: new Response("").body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
      })),
    ).rejects.toThrow(/no token/);
  });

  test("a missing token surfaces as a -32603 from a ticket verb", async () => {
    getSecretImpl = async () => null;
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── list ─────────────────────────────────────────────────────────────

describe("list", () => {
  test("returns mapped items, filtered + capped", async () => {
    fakeClient = makeClient({
      fetchBoardItems: async () => ({
        items: [
          boardItem({ itemNodeId: "a", statusName: "Done", updatedAt: "2026-06-22T00:00:00Z" }),
          boardItem({ itemNodeId: "b", statusName: "In Progress", updatedAt: "2026-06-23T00:00:00Z" }),
          boardItem({ itemNodeId: "c", statusName: "In Progress", updatedAt: "2026-06-21T00:00:00Z" }),
        ],
        cursor: {},
      }),
    });
    const res = await handleGithubProjectsRpc(
      "list",
      req(V("list"), { status: "in progress", limit: 1 }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    const items = (res as { result: { items: GithubBoardItem[] } }).result.items;
    // case-insensitive filter keeps b + c; newest-first → b; limit 1.
    expect(items.map((i) => i.itemNodeId)).toEqual(["b"]);
  });

  test("propagates a client fetch error as -32603", async () => {
    fakeClient = makeClient({
      fetchBoardItems: async () => {
        throw new Error("boom");
      },
    });
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── create / update / move / archive / comment ───────────────────────

describe("ticket mutations", () => {
  test("create requires a title", async () => {
    const res = await handleGithubProjectsRpc("create", req(V("create"), {}), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("create issues a draft on the board + writes an audit row", async () => {
    let createArgs: unknown;
    fakeClient = makeClient({
      createIssueOnBoard: async (board, _auth, input) => {
        createArgs = { board, input };
        return { itemNodeId: "PVTI_new", contentNodeId: null, url: null, title: input.title };
      },
    });
    const res = await handleGithubProjectsRpc(
      "create",
      req(V("create"), { title: "  New card  ", body: "b", statusName: "Todo" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(createArgs).toEqual({
      board: "PVT_board1",
      input: { title: "New card", body: "b", statusName: "Todo" },
    });
    expect(auditRows.some((r) => r.action.includes("ticket-mutate"))).toBe(true);
  });

  test("update requires itemNodeId then calls updateItem", async () => {
    const miss = await handleGithubProjectsRpc("update", req(V("update"), {}), ctx());
    expect("error" in miss && miss.error?.code).toBe(-32602);
    let called = false;
    fakeClient = makeClient({
      updateItem: async () => {
        called = true;
        return { itemNodeId: "PVTI_item1", contentNodeId: "I", url: null, title: "u" };
      },
    });
    const res = await handleGithubProjectsRpc(
      "update",
      req(V("update"), { itemNodeId: "PVTI_item1", title: "u" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(called).toBe(true);
  });

  test("update rejects a node id that is NOT on this board (containment)", async () => {
    // `client.updateItem` PATCHes the underlying issue of ANY node id the token
    // can write to, so a forged/off-board id must be refused host-side BEFORE
    // the client is driven — exactly like `comment`.
    let updateCalled = false;
    fakeClient = makeClient({
      fetchBoardItems: async () => ({ items: [boardItem()], cursor: {} }),
      updateItem: async () => {
        updateCalled = true;
        return { itemNodeId: "PVTI_evil", contentNodeId: "I", url: null, title: "pwned" };
      },
    });
    const res = await handleGithubProjectsRpc(
      "update",
      req(V("update"), { itemNodeId: "PVTI_other_board", title: "pwned" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("not found on this board");
    expect(updateCalled).toBe(false);
    // No mutation happened, so no ticket-mutate audit row either.
    expect(auditRows.some((r) => r.action.includes("ticket-mutate"))).toBe(false);
  });

  test("update still succeeds for an on-board node id (membership resolved first)", async () => {
    const calls: string[] = [];
    fakeClient = makeClient({
      fetchBoardItems: async () => {
        calls.push("fetchBoardItems");
        return { items: [boardItem({ itemNodeId: "PVTI_mine" })], cursor: {} };
      },
      updateItem: async (_b, _a, input) => {
        calls.push("updateItem");
        return { itemNodeId: input.itemNodeId, contentNodeId: "I", url: null, title: "u" };
      },
    });
    const res = await handleGithubProjectsRpc(
      "update",
      req(V("update"), { itemNodeId: "PVTI_mine", title: "u" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    // Board membership is confirmed BEFORE the write is issued.
    expect(calls).toEqual(["fetchBoardItems", "updateItem"]);
    expect(auditRows.some((r) => r.action.includes("ticket-mutate"))).toBe(true);
  });

  test("move resolves a status name → option id and sets it", async () => {
    let setArgs: unknown[] = [];
    fakeClient = makeClient({
      setItemStatus: async (board, _auth, item, optionId) => {
        setArgs = [board, item, optionId];
      },
    });
    const res = await handleGithubProjectsRpc(
      "move",
      req(V("move"), { itemNodeId: "PVTI_item1", statusName: "done" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(setArgs).toEqual(["PVT_board1", "PVTI_item1", "opt-done"]);
  });

  test("move rejects an unknown status name", async () => {
    const res = await handleGithubProjectsRpc(
      "move",
      req(V("move"), { itemNodeId: "PVTI_item1", statusName: "Nonexistent" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("move requires both itemNodeId and statusName", async () => {
    const a = await handleGithubProjectsRpc("move", req(V("move"), { statusName: "Done" }), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc("move", req(V("move"), { itemNodeId: "x" }), ctx());
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("archive removes the item", async () => {
    let archived = "";
    fakeClient = makeClient({
      archiveItem: async (_b, _a, item) => {
        archived = item;
      },
    });
    const res = await handleGithubProjectsRpc(
      "archive",
      req(V("archive"), { itemNodeId: "PVTI_item1" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(archived).toBe("PVTI_item1");
  });

  test("archive requires itemNodeId", async () => {
    const res = await handleGithubProjectsRpc("archive", req(V("archive"), {}), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("comment posts to the underlying issue", async () => {
    let commentArgs: unknown[] = [];
    fakeClient = makeClient({
      addComment: async (_auth, content, body) => {
        commentArgs = [content, body];
      },
    });
    const res = await handleGithubProjectsRpc(
      "comment",
      req(V("comment"), { itemNodeId: "PVTI_item1", body: "hi" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(commentArgs).toEqual(["I_issue1", "hi"]);
  });

  test("comment rejects a draft card with no issue", async () => {
    fakeClient = makeClient({
      fetchBoardItems: async () => ({
        items: [boardItem({ itemNodeId: "PVTI_item1", contentNodeId: null })],
        cursor: {},
      }),
    });
    const res = await handleGithubProjectsRpc(
      "comment",
      req(V("comment"), { itemNodeId: "PVTI_item1", body: "hi" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("draft");
  });

  test("comment rejects an unknown item", async () => {
    fakeClient = makeClient({
      fetchBoardItems: async () => ({ items: [], cursor: {} }),
    });
    const res = await handleGithubProjectsRpc(
      "comment",
      req(V("comment"), { itemNodeId: "PVTI_missing", body: "hi" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("comment requires itemNodeId and body", async () => {
    const a = await handleGithubProjectsRpc("comment", req(V("comment"), { body: "x" }), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc(
      "comment",
      req(V("comment"), { itemNodeId: "PVTI_item1" }),
      ctx(),
    );
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("update requires itemNodeId (explicit)", async () => {
    const res = await handleGithubProjectsRpc("update", req(V("update"), { title: "x" }), ctx());
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("a client throw during a mutation surfaces as -32603", async () => {
    fakeClient = makeClient({
      createIssueOnBoard: async () => {
        throw new Error("rate limited");
      },
    });
    const res = await handleGithubProjectsRpc(
      "create",
      req(V("create"), { title: "x" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── dashboard-data (viewing-user scoped) ─────────────────────────────

describe("dashboard-data", () => {
  test("returns the viewing user's proposals + boards", async () => {
    _setLinksByUserForTests(async (userId) => {
      expect(userId).toBe("user-1");
      return [link({ projectId: "proj-7" })];
    });
    listProposalsByProjectImpl = async () => [
      proposal({ status: "running", projectId: "proj-7", conversationId: "conv-7" }),
    ];
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    expect("result" in res).toBe(true);
    const data = (
      res as {
        result: { proposals: { projectId: string; conversationId: string | null }[]; boards: unknown[] };
      }
    ).result;
    expect(data.boards.length).toBe(1);
    expect(data.proposals.length).toBe(1);
    // The projection MUST carry the link's projectId so the dashboard can build
    // the project-scoped chat href (`/project/<projectId>/chat/<convId>`).
    expect(data.proposals[0]!.projectId).toBe("proj-7");
    expect(data.proposals[0]!.conversationId).toBe("conv-7");
  });

  test("multi-board project: each proposal appears ONCE, under its OWN board's title", async () => {
    // Two of the viewing user's boards share ONE project, and a THIRD link in
    // the same project belongs to another user. listProposalsByProject is
    // PROJECT-scoped, so without per-link filtering every proposal would show
    // once per link (half under the wrong title) and the other user's
    // proposal would leak in.
    _setLinksByUserForTests(async () => [
      link({ id: "link-A", projectId: "proj-1", boardTitle: "Board A" }),
      link({ id: "link-B", projectId: "proj-1", boardTitle: "Board B" }),
    ]);
    listProposalsByProjectImpl = async () => [
      proposal({ id: "prop-A", linkId: "link-A", title: "On A" }),
      proposal({ id: "prop-B", linkId: "link-B", title: "On B" }),
      // Another user's board in the SAME project — must be excluded.
      proposal({ id: "prop-other", linkId: "link-other-user", title: "Not mine" }),
    ];
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    expect("result" in res).toBe(true);
    const data = (
      res as { result: { proposals: { id: string; boardTitle: string }[] } }
    ).result;
    // Exactly once each — no per-link duplication (duplicate ids would break
    // keyed rendering) — and each stamped with its OWN board's title.
    expect(data.proposals.map((p) => [p.id, p.boardTitle]).sort()).toEqual([
      ["prop-A", "Board A"],
      ["prop-B", "Board B"],
    ]);
  });

  test("rejects an ownerless fire (no viewing user)", async () => {
    const res = await handleGithubProjectsRpc(
      "dashboard-data",
      req(V("dashboard-data")),
      ctx({ userId: null }),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
  });

  test("returns empty arrays when the user has no boards", async () => {
    _setLinksByUserForTests(async () => []);
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    const data = (res as { result: { proposals: unknown[]; boards: unknown[] } }).result;
    expect(data.boards).toEqual([]);
    expect(data.proposals).toEqual([]);
  });
});

// ── approve / dismiss (ownership) ────────────────────────────────────

describe("approve / dismiss ownership", () => {
  test("approve spawns when the user owns the proposal's link", async () => {
    getProposalByIdImpl = async () => proposal();
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect(spawnCalls[0]?.method).toBe("approve");
    expect(spawnCalls[0]?.args).toEqual(["prop-1", { kind: "user", userId: "user-1" }]);
  });

  test("approve is opaque (-32603) when the user does NOT own the link", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other-user" });
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(spawnCalls.length).toBe(0);
  });

  test("approve is opaque when the proposal is missing", async () => {
    getProposalByIdImpl = async () => null;
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "nope" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(spawnCalls.length).toBe(0);
  });

  test("approve requires a proposalId + a viewing user", async () => {
    const a = await handleGithubProjectsRpc("approve", req(V("approve"), {}), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "p" }),
      ctx({ userId: null }),
    );
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("approve maps a spawn throw to -32603", async () => {
    approveImpl = async () => {
      throw new Error("spawn boom");
    };
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });

  test("dismiss dismisses when owned", async () => {
    const res = await handleGithubProjectsRpc(
      "dismiss",
      req(V("dismiss"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect(spawnCalls[0]).toEqual({ method: "dismiss", args: ["prop-1", "user-1"] });
  });

  test("dismiss is opaque when not owned", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other" });
    const res = await handleGithubProjectsRpc(
      "dismiss",
      req(V("dismiss"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });

  test("dismiss maps a throw to -32603", async () => {
    dismissImpl = async () => {
      throw new Error("nope");
    };
    const res = await handleGithubProjectsRpc(
      "dismiss",
      req(V("dismiss"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── rerun (ownership + typed-error mapping) ──────────────────────────

describe("rerun", () => {
  test("re-runs a terminal proposal when the user owns the link (new pending row + audit + emit)", async () => {
    getProposalByIdImpl = async () => proposal({ status: "done" });
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect((res as { result: Record<string, unknown> }).result).toEqual({
      ok: true,
      status: "pending",
      proposalId: "prop-new",
    });
    // The spawn bridge got the SOURCE proposal id + the acting user.
    expect(spawnCalls[0]).toEqual({
      method: "rerun",
      args: ["prop-1", { kind: "user", userId: "user-1" }],
    });
    // Audit row written (control action, both proposal ids in the metadata).
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe("ext:github-projects:control");
    expect(auditRows[0]!.userId).toBe("user-1");
    expect(auditRows[0]!.metadata).toMatchObject({
      verb: "rerun",
      proposalId: "prop-1",
      newProposalId: "prop-new",
    });
    // The proposal-update event fired so every dashboard refreshes.
    expect(emitCalls).toEqual([
      { event: GITHUB_PROJECTS_EVENT, payload: { projectId: "proj-1" } },
    ]);
  });

  test("rerun is opaque (-32603) when the user does NOT own the link — no bridge call, no audit, no emit", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other-user" });
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect("error" in res && res.error?.message).toBe("Proposal not found");
    expect(spawnCalls.length).toBe(0);
    expect(auditRows).toHaveLength(0);
    expect(emitCalls).toHaveLength(0);
  });

  test("rerun is opaque when the proposal is missing", async () => {
    getProposalByIdImpl = async () => null;
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "nope" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(spawnCalls.length).toBe(0);
  });

  test("rerun requires a proposalId + a viewing user", async () => {
    const a = await handleGithubProjectsRpc("rerun", req(V("rerun"), {}), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "p" }),
      ctx({ userId: null }),
    );
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("a not-terminal source maps to a clear -32602 naming the status (no audit, no emit)", async () => {
    rerunImpl = async () => {
      throw new GithubProposalNotRerunnableError("running");
    };
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toBe(
      "Proposal is not re-runnable (status: running)",
    );
    expect(auditRows).toHaveLength(0);
    expect(emitCalls).toHaveLength(0);
  });

  test("a busy card maps to a clear -32602", async () => {
    rerunImpl = async () => {
      throw new GithubCardBusyError();
    };
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toBe("Card already has an active proposal");
  });

  test("an untyped bridge throw maps to -32603", async () => {
    rerunImpl = async () => {
      throw new Error("db down");
    };
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect("error" in res && res.error?.message).toContain("rerun failed");
  });

  test("rerun still succeeds when no emit is registered (backend-only boot)", async () => {
    _resetGithubProjectsEmitForTests();
    const res = await handleGithubProjectsRpc(
      "rerun",
      req(V("rerun"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(emitCalls).toHaveLength(0);
  });
});

// ── pause / resume (ownership) ───────────────────────────────────────

describe("pause / resume", () => {
  test("pause disables the link when owned", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    const res = await handleGithubProjectsRpc(
      "pause",
      req(V("pause"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect(queryCalls.find((c) => c.method === "setLinkEnabled")?.args).toEqual(["link-1", false]);
  });

  test("resume enables the link when owned", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    const res = await handleGithubProjectsRpc(
      "resume",
      req(V("resume"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect(queryCalls.find((c) => c.method === "setLinkEnabled")?.args).toEqual(["link-1", true]);
  });

  test("pause is opaque when not owned", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other" });
    const res = await handleGithubProjectsRpc(
      "pause",
      req(V("pause"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(queryCalls.some((c) => c.method === "setLinkEnabled")).toBe(false);
  });

  test("pause is opaque when the link is missing", async () => {
    getLinkByIdImpl = async () => null;
    const res = await handleGithubProjectsRpc(
      "pause",
      req(V("pause"), { linkId: "nope" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });

  test("pause requires a linkId + a viewing user", async () => {
    const a = await handleGithubProjectsRpc("pause", req(V("pause"), {}), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc(
      "pause",
      req(V("pause"), { linkId: "l" }),
      ctx({ userId: null }),
    );
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("resume maps a query throw to -32603", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    setLinkEnabledImpl = async () => {
      throw new Error("db down");
    };
    const res = await handleGithubProjectsRpc(
      "resume",
      req(V("resume"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── poll-now (ownership) ─────────────────────────────────────────────

describe("poll-now", () => {
  test("forces a poll of the SPECIFIC resolved link when owned + writes an audit row", async () => {
    const owned = link({ id: "link-7", projectId: "proj-real", createdByUserId: "user-1" });
    getLinkByIdImpl = async () => owned;
    pollLinkNowImpl = async () => ({ polled: true });
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-7" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect((res as { result: { ok: boolean; polled: boolean } }).result).toEqual({
      ok: true,
      polled: true,
    });
    // The daemon was driven with the resolved link itself (not the projectId).
    expect(daemonCalls).toHaveLength(1);
    expect(daemonCalls[0]!.method).toBe("pollLinkNow");
    expect((daemonCalls[0]!.args[0] as { id: string }).id).toBe("link-7");
    // An AUDIT_CONTROL row with the poll-now verb was written.
    expect(
      auditRows.some(
        (r) =>
          r.action.includes("control") &&
          (r.metadata as { verb?: string })?.verb === "poll-now",
      ),
    ).toBe(true);
  });

  test("surfaces the daemon reason (paused) in the result", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    pollLinkNowImpl = async () => ({ polled: false, reason: "paused" });
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect((res as { result: { ok: boolean; polled: boolean; reason?: string } }).result).toEqual({
      ok: true,
      polled: false,
      reason: "paused",
    });
  });

  test("is opaque (-32603) when the user does NOT own the link", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other-user" });
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(daemonCalls.length).toBe(0);
  });

  test("is opaque when the link is missing", async () => {
    getLinkByIdImpl = async () => null;
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "nope" }),
      ctx(),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    expect(daemonCalls.length).toBe(0);
  });

  test("requires a linkId + a viewing user", async () => {
    const a = await handleGithubProjectsRpc("poll-now", req(V("poll-now"), {}), ctx());
    expect("error" in a && a.error?.code).toBe(-32602);
    const b = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "l" }),
      ctx({ userId: null }),
    );
    expect("error" in b && b.error?.code).toBe(-32602);
  });

  test("maps a daemon throw to -32603", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    pollLinkNowImpl = async () => {
      throw new Error("poll boom");
    };
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
  });
});

// ── Extension RBAC (deny-by-default verb matrix) ─────────────────────
//
// approve/dismiss/rerun → `approve-runs`; poll-now → `use`; ticket MUTATIONS
// → the custom scope `write-tickets`; dashboard-data degrades gracefully
// (empty + permissionDenied) instead of erroring. `list` and pause/resume are
// NOT gated (spec v1). Ownership guards stay FIRST (opaque), the RBAC denial
// second (named scope). The resolver itself is core-tested; here we pin the
// wiring: which scope, at which (project, extension) coordinates, and that a
// denial short-circuits before any bridge/daemon/client call or audit row.
describe("extension RBAC — handler verbs", () => {
  const denyScope = (scope: string) => {
    hasScopeImpl = async (_u, q) => q.scope !== scope;
  };
  const expectScopeDenial = (res: Awaited<ReturnType<typeof handleGithubProjectsRpc>>, scope: string) => {
    expect("error" in res && res.error?.code).toBe(-32603);
    expect("error" in res && res.error?.message).toBe(
      `Missing extension scope '${scope}' for github-projects`,
    );
  };

  test.each(["approve", "dismiss", "rerun"] as const)(
    "%s without 'approve-runs' → denial naming the scope, no bridge call, no audit, no emit",
    async (verb) => {
      getProposalByIdImpl = async () => proposal({ status: verb === "rerun" ? "done" : "pending" });
      denyScope("approve-runs");
      const res = await handleGithubProjectsRpc(verb, req(V(verb), { proposalId: "prop-1" }), ctx());
      expectScopeDenial(res, "approve-runs");
      expect(spawnCalls).toHaveLength(0);
      expect(auditRows).toHaveLength(0);
      expect(emitCalls).toHaveLength(0);
      // Checked at the proposal's OWN (project, extension) coordinates.
      expect(rbacCalls).toEqual([
        {
          userId: "user-1",
          role: "member",
          projectId: "proj-1",
          extensionId: "github-projects",
          scope: "approve-runs",
        },
      ]);
    },
  );

  test("the opaque ownership guard runs BEFORE the RBAC check (no scope oracle for foreign proposals)", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "other-user" });
    denyScope("approve-runs");
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "prop-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("error" in res && res.error?.message).toBe("Proposal not found");
    expect(rbacCalls).toHaveLength(0);
  });

  test("approve with 'approve-runs' granted (member) still spawns", async () => {
    hasScopeImpl = async (_u, q) => q.scope === "approve-runs";
    const res = await handleGithubProjectsRpc(
      "approve",
      req(V("approve"), { proposalId: "prop-1" }),
      ctx(),
    );
    expect("result" in res).toBe(true);
    expect(spawnCalls[0]?.method).toBe("approve");
  });

  test("poll-now without 'use' → denial naming the scope, daemon never driven", async () => {
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    denyScope("use");
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expectScopeDenial(res, "use");
    expect(daemonCalls).toHaveLength(0);
    expect(rbacCalls[0]).toMatchObject({ projectId: "proj-1", extensionId: "github-projects", scope: "use" });
  });

  test("an unknown acting-user row is fail-closed (denial), without ever consulting grants", async () => {
    getUserByIdImpl = async () => undefined;
    const res = await handleGithubProjectsRpc(
      "poll-now",
      req(V("poll-now"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expectScopeDenial(res, "use");
    expect(rbacCalls).toHaveLength(0);
    expect(daemonCalls).toHaveLength(0);
  });

  test.each(["create", "update", "move", "archive", "comment"] as const)(
    "%s without 'write-tickets' → denial naming the custom scope, no GitHub write, no audit",
    async (verb) => {
      let clientDriven = false;
      fakeClient = makeClient({
        createIssueOnBoard: async () => {
          clientDriven = true;
          return { itemNodeId: "PVTI_new", contentNodeId: null, url: null, title: "New" };
        },
        updateItem: async () => {
          clientDriven = true;
          return { itemNodeId: "PVTI_item1", contentNodeId: "I", url: null, title: "u" };
        },
        setItemStatus: async () => {
          clientDriven = true;
        },
        archiveItem: async () => {
          clientDriven = true;
        },
        addComment: async () => {
          clientDriven = true;
        },
      });
      denyScope("write-tickets");
      const res = await handleGithubProjectsRpc(
        verb,
        req(V(verb), { title: "t", itemNodeId: "PVTI_item1", statusName: "Done", body: "b" }),
        ctx(),
      );
      expectScopeDenial(res, "write-tickets");
      expect(clientDriven).toBe(false);
      expect(auditRows).toHaveLength(0);
      // Checked at the CONVERSATION-derived project (never from params).
      expect(rbacCalls).toEqual([
        {
          userId: "user-1",
          role: "member",
          projectId: "proj-1",
          extensionId: "github-projects",
          scope: "write-tickets",
        },
      ]);
    },
  );

  test("a ticket mutation with NO acting user is fail-closed (-32602), even with a valid conversation", async () => {
    const res = await handleGithubProjectsRpc(
      "create",
      req(V("create"), { title: "t" }),
      ctx({ userId: null }),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toBe("No acting user.");
    expect(auditRows).toHaveLength(0);
  });

  test("create WITH 'write-tickets' granted (member) proceeds + audits", async () => {
    hasScopeImpl = async (_u, q) => q.scope === "write-tickets";
    const res = await handleGithubProjectsRpc("create", req(V("create"), { title: "ok" }), ctx());
    expect("result" in res).toBe(true);
    expect(auditRows.some((r) => r.action.includes("ticket-mutate"))).toBe(true);
  });

  test("`list` is NOT RBAC-gated (read-only, PDP-gated at the tool call)", async () => {
    hasScopeImpl = async () => false; // deny EVERYTHING — list must still work
    const res = await handleGithubProjectsRpc("list", req(V("list")), ctx());
    expect("result" in res).toBe(true);
    expect(rbacCalls).toHaveLength(0);
  });

  test("pause/resume stay owner-gated only (not RBAC-gated in v1)", async () => {
    hasScopeImpl = async () => false;
    getLinkByIdImpl = async () => link({ createdByUserId: "user-1" });
    const res = await handleGithubProjectsRpc(
      "pause",
      req(V("pause"), { linkId: "link-1" }),
      ctx({ userId: "user-1" }),
    );
    expect("result" in res).toBe(true);
    expect(rbacCalls).toHaveLength(0);
  });

  test("dashboard-data: viewer with boards but NO 'use' anywhere → empty dashboard + permissionDenied (not an error)", async () => {
    _setLinksByUserForTests(async () => [link()]);
    hasScopeImpl = async () => false;
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    expect("result" in res).toBe(true);
    expect((res as { result: unknown }).result).toEqual({
      proposals: [],
      boards: [],
      permissionDenied: true,
    });
  });

  test("dashboard-data: an unknown provenance user is fail-closed to the same graceful shape", async () => {
    getUserByIdImpl = async () => undefined;
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    expect((res as { result: unknown }).result).toEqual({
      proposals: [],
      boards: [],
      permissionDenied: true,
    });
    expect(rbacCalls).toHaveLength(0);
  });

  test("dashboard-data: per-board `use` filter — a project-scoped grant never leaks the OTHER project's board in", async () => {
    _setLinksByUserForTests(async () => [
      link({ id: "link-A", projectId: "proj-A", boardTitle: "Board A" }),
      link({ id: "link-B", projectId: "proj-B", boardTitle: "Board B" }),
    ]);
    hasScopeImpl = async (_u, q) => q.projectId === "proj-A"; // use granted on proj-A only
    listProposalsByProjectImpl = async (p) =>
      p === "proj-A" ? [proposal({ id: "prop-A", linkId: "link-A", projectId: "proj-A" })] : [proposal({ id: "prop-B", linkId: "link-B", projectId: "proj-B" })];
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    const data = (
      res as { result: { boards: { linkId: string }[]; proposals: { id: string }[]; permissionDenied?: boolean } }
    ).result;
    expect(data.boards.map((b) => b.linkId)).toEqual(["link-A"]);
    expect(data.proposals.map((p) => p.id)).toEqual(["prop-A"]);
    // Partial visibility is NOT flagged — only an all-denied dashboard is.
    expect(data.permissionDenied).toBeUndefined();
    // One `use` check per board, at each board's own project coordinate.
    expect(rbacCalls.map((c) => [c.projectId, c.scope])).toEqual([
      ["proj-A", "use"],
      ["proj-B", "use"],
    ]);
  });

  test("dashboard-data: a viewer with ZERO boards keeps the plain empty dashboard (no flag — nothing withheld)", async () => {
    _setLinksByUserForTests(async () => []);
    hasScopeImpl = async () => false;
    const res = await handleGithubProjectsRpc("dashboard-data", req(V("dashboard-data")), ctx());
    const data = (res as { result: { boards: unknown[]; proposals: unknown[]; permissionDenied?: boolean } }).result;
    expect(data.boards).toEqual([]);
    expect(data.proposals).toEqual([]);
    expect(data.permissionDenied).toBeUndefined();
  });
});

// ── Unknown verb ─────────────────────────────────────────────────────

test("unknown verb → -32601", async () => {
  const res = await handleGithubProjectsRpc("frobnicate", req(V("frobnicate")), ctx());
  expect("error" in res && res.error?.code).toBe(-32601);
});

// Integration coverage (real PGlite + real queries) lives in a SEPARATE file
// (`github-projects-handler.integration.test.ts`) so the query layer is NOT
// `mock.module`'d there — mixing a mocked query module with real queries in one
// file caused the seam impls to self-reference the mock.
