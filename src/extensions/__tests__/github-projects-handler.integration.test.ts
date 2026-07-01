// Integration tests for src/extensions/github-projects-handler.ts.
//
// Real PGlite + real DB queries (github-projects.ts + conversations.ts) +
// mocked GitHub client / spawn bridge / secrets store (no network, no gh).
// Proves a ticket verb resolves the link by the CONVERSATION's projectId (never
// from params), and a control verb mutates the right row with owner-gating.
//
// Distinct from the unit file: the query layer is NOT `mock.module`'d here, so
// the handler exercises the genuine Drizzle queries against the test database.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type {
  GithubClient,
  GithubFetchPage,
} from "../../integrations/github-projects/types";
import type { GithubProjectsProposal } from "../../db/schema";

// ── db/connection → test PGlite (the REAL queries read through this) ──
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

// ── Mocked external collaborators (no real network / gh / crypto) ────
// The host-only secrets store: `resolveAuth` reads the PAT through it.
mock.module("../secrets-store", () => ({
  getSecret: async () => "ghp_token",
}));

// In-file restore pattern (mock-cleanup-coverage): client + spawn are NOT in
// mock-cleanup's MODULE_PATHS, so snapshot the real exports before stubbing and
// re-register them in afterAll (also prevents leakage into sibling test files).
const REAL_CLIENT = { ...(await import("../../integrations/github-projects/client")) };
const REAL_SPAWN = { ...(await import("../../integrations/github-projects/spawn")) };

let fakeClient: GithubClient;
mock.module("../../integrations/github-projects/client", () => ({
  createGithubClient: () => fakeClient,
}));

const spawnCalls: Array<{ method: string; args: unknown[] }> = [];
mock.module("../../integrations/github-projects/spawn", () => ({
  approveProposal: async (id: string, actor: unknown) => {
    spawnCalls.push({ method: "approve", args: [id, actor] });
    return { id, status: "spawned" } as GithubProjectsProposal;
  },
  dismissProposal: async (id: string, userId: string) => {
    spawnCalls.push({ method: "dismiss", args: [id, userId] });
    return { id, status: "dismissed" } as GithubProjectsProposal;
  },
}));

const { handleGithubProjectsRpc } = await import("../github-projects-handler");
const { GITHUB_PROJECTS_RPC_PREFIX } = await import("../../integrations/github-projects/types");
const realQueries = await import("../../db/queries/github-projects");

afterAll(() => {
  mock.module("../../integrations/github-projects/client", () => REAL_CLIENT);
  mock.module("../../integrations/github-projects/spawn", () => REAL_SPAWN);
  restoreModuleMocks();
});

const V = (verb: string) => `${GITHUB_PROJECTS_RPC_PREFIX}${verb}`;
function reqMsg(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, id: 1, method, params };
}
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    extensionName: "github-projects",
    extensionId: "ext-gp",
    userId: "user-1",
    conversationId: "conv-1",
    grantedPermissions: { grantedAt: {} },
    ...over,
  } as Parameters<typeof handleGithubProjectsRpc>[2];
}

function fakeGithubClient(over: Partial<GithubClient> = {}): GithubClient {
  const noop = async () => undefined as never;
  return {
    resolveBoardFromUrl: async () => ({
      boardNodeId: "PVT_int",
      title: "Integration Board",
      ownerLogin: "acme",
      statusFieldId: "FIELD_status",
      statusOptions: [{ id: "opt-done", name: "Done" }],
    }),
    validateAuth: async () => ({ ok: true, scopes: [], missingScopes: [] }),
    fetchBoardItems: async (): Promise<GithubFetchPage> => ({
      items: [
        {
          itemNodeId: "PVTI_int1",
          contentNodeId: "I_int1",
          title: "Integration card",
          url: "https://github.com/acme/repo/issues/1",
          statusOptionId: "opt-todo",
          statusName: "Todo",
          updatedAt: "2026-06-24T00:00:00Z",
        },
      ],
      cursor: {},
    }),
    createIssueOnBoard: async () => ({
      itemNodeId: "PVTI_new",
      contentNodeId: null,
      url: null,
      title: "New",
    }),
    updateItem: async () => ({
      itemNodeId: "PVTI_int1",
      contentNodeId: "I_int1",
      url: null,
      title: "u",
    }),
    setItemStatus: noop,
    archiveItem: noop,
    addComment: noop,
    ...over,
  };
}

async function seed(opts: { enabled?: boolean } = {}) {
  const { getDb } = await import("../../db/connection");
  const db = getDb();
  const schema = await import("../../db/schema");
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const convId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `u${userId.slice(0, 8)}@x.test`,
    passwordHash: "x",
    name: "Test User",
    role: "member",
  });
  await db.insert(schema.projects).values({ id: projectId, name: "P", path: "/tmp/p" });
  await db.insert(schema.conversations).values({ id: convId, title: "C", projectId, userId });
  const [link] = await db
    .insert(schema.githubProjectsLinks)
    .values({
      projectId,
      boardNodeId: "PVT_int",
      boardUrl: "https://github.com/orgs/acme/projects/2",
      boardTitle: "Integration Board",
      ownerLogin: "acme",
      authMode: "pat",
      enabled: opts.enabled ?? true,
      createdByUserId: userId,
    })
    .returning();
  const [proposal] = await db
    .insert(schema.githubProjectsProposals)
    .values({
      projectId,
      linkId: link!.id,
      itemNodeId: "PVTI_int1",
      contentNodeId: "I_int1",
      statusOptionId: "opt-progress",
      statusName: "In Progress",
      action: "execute",
      title: "Integration proposal",
      dedupeKey: `${projectId}:PVTI_int1:opt-progress:execute`,
      status: "pending",
    })
    .returning();
  return { userId, projectId, convId, linkId: link!.id, proposalId: proposal!.id };
}

beforeAll(async () => {
  await setupTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(() => {
  spawnCalls.length = 0;
  fakeClient = fakeGithubClient();
});

describe("github-projects handler — integration (real DB)", () => {
  test("a ticket verb resolves the link by the conversation's projectId", async () => {
    const { convId } = await seed();
    // params carry a FORGED board id — the handler must ignore it and derive
    // the board from the conversation's project.
    const res = await handleGithubProjectsRpc(
      "list",
      reqMsg(V("list"), { projectId: "FORGED", boardId: "PVT_evil" }),
      makeCtx({ conversationId: convId }),
    );
    expect("result" in res).toBe(true);
    const items = (res as { result: { items: unknown[] } }).result.items;
    expect(items.length).toBe(1);
  });

  test("list errors clearly when the conversation's project has no board", async () => {
    const { getDb } = await import("../../db/connection");
    const db = getDb();
    const schema = await import("../../db/schema");
    const userId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const convId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email: `u${userId.slice(0, 8)}@x.test`,
      passwordHash: "x",
      name: "U",
      role: "member",
    });
    await db.insert(schema.projects).values({ id: projectId, name: "NB", path: "/tmp/nb" });
    await db.insert(schema.conversations).values({ id: convId, title: "C", projectId, userId });
    const res = await handleGithubProjectsRpc(
      "list",
      reqMsg(V("list")),
      makeCtx({ conversationId: convId }),
    );
    expect("error" in res && res.error?.code).toBe(-32602);
    expect("error" in res && res.error?.message).toContain("No GitHub Projects board");
  });

  test("pause flips enabled=false on the real row, owner-gated", async () => {
    const { userId, linkId } = await seed({ enabled: true });
    const res = await handleGithubProjectsRpc(
      "pause",
      reqMsg(V("pause"), { linkId }),
      makeCtx({ userId, conversationId: "irrelevant" }),
    );
    expect("result" in res).toBe(true);
    const after = await realQueries.getLinkById(linkId);
    expect(after?.enabled).toBe(false);
  });

  test("pause by a non-owner is opaque + does NOT mutate the row", async () => {
    const { linkId } = await seed({ enabled: true });
    const res = await handleGithubProjectsRpc(
      "pause",
      reqMsg(V("pause"), { linkId }),
      makeCtx({ userId: crypto.randomUUID(), conversationId: "x" }),
    );
    expect("error" in res && res.error?.code).toBe(-32603);
    const after = await realQueries.getLinkById(linkId);
    expect(after?.enabled).toBe(true); // unchanged
  });

  test("dashboard-data returns the owner's proposals + boards only", async () => {
    const mine = await seed();
    // A second user's board + proposal must NOT leak into mine's dashboard.
    await seed();
    const res = await handleGithubProjectsRpc(
      "dashboard-data",
      reqMsg(V("dashboard-data")),
      makeCtx({ userId: mine.userId, conversationId: "any" }),
    );
    expect("result" in res).toBe(true);
    const data = (res as { result: { proposals: { id: string }[]; boards: { linkId: string }[] } })
      .result;
    expect(data.boards.map((b) => b.linkId)).toEqual([mine.linkId]);
    expect(data.proposals.map((p) => p.id)).toEqual([mine.proposalId]);
  });

  test("dashboard-data scopes proposals per LINK when one project has many boards", async () => {
    // ONE project, TWO boards: mine and another user's. listProposalsByProject
    // is project-scoped, so the per-link filter must (a) keep my proposal
    // exactly once under MY board's title and (b) exclude the other user's
    // link's proposal even though it lives in the same project.
    const { getDb } = await import("../../db/connection");
    const db = getDb();
    const schema = await import("../../db/schema");
    const myUserId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    for (const id of [myUserId, otherUserId]) {
      await db.insert(schema.users).values({
        id,
        email: `u${id.slice(0, 8)}@x.test`,
        passwordHash: "x",
        name: "U",
        role: "member",
      });
    }
    await db.insert(schema.projects).values({ id: projectId, name: "MB", path: "/tmp/mb" });
    const mkLink = async (owner: string, title: string, boardNodeId: string) =>
      (
        await db
          .insert(schema.githubProjectsLinks)
          .values({
            projectId,
            boardNodeId,
            boardUrl: `https://github.com/orgs/acme/projects/${boardNodeId}`,
            boardTitle: title,
            ownerLogin: "acme",
            authMode: "pat",
            enabled: true,
            createdByUserId: owner,
          })
          .returning()
      )[0]!;
    const mkProposal = async (linkId: string, itemNodeId: string, title: string) =>
      (
        await db
          .insert(schema.githubProjectsProposals)
          .values({
            projectId,
            linkId,
            itemNodeId,
            contentNodeId: `I_${itemNodeId}`,
            statusOptionId: "opt-progress",
            statusName: "In Progress",
            action: "execute",
            title,
            dedupeKey: `${projectId}:${itemNodeId}:opt-progress:execute`,
            status: "pending",
          })
          .returning()
      )[0]!;
    const myLink = await mkLink(myUserId, "My Board", "PVT_mine");
    const otherLink = await mkLink(otherUserId, "Other Board", "PVT_other");
    const myProposal = await mkProposal(myLink.id, "PVTI_mine", "Mine");
    await mkProposal(otherLink.id, "PVTI_other", "Not mine");

    const res = await handleGithubProjectsRpc(
      "dashboard-data",
      reqMsg(V("dashboard-data")),
      makeCtx({ userId: myUserId, conversationId: "any" }),
    );
    expect("result" in res).toBe(true);
    const data = (
      res as {
        result: {
          proposals: { id: string; boardTitle: string }[];
          boards: { linkId: string }[];
        };
      }
    ).result;
    expect(data.boards.map((b) => b.linkId)).toEqual([myLink.id]);
    // Exactly once, under MY board's title; the other user's proposal in the
    // SAME project never leaks in.
    expect(data.proposals.map((p) => [p.id, p.boardTitle])).toEqual([
      [myProposal.id, "My Board"],
    ]);
  });

  test("approve spawns + is owner-gated on the real proposal row", async () => {
    const { userId, proposalId } = await seed();
    const ok = await handleGithubProjectsRpc(
      "approve",
      reqMsg(V("approve"), { proposalId }),
      makeCtx({ userId, conversationId: "any" }),
    );
    expect("result" in ok).toBe(true);
    expect(spawnCalls[0]).toEqual({
      method: "approve",
      args: [proposalId, { kind: "user", userId }],
    });

    // A different user cannot approve someone else's proposal (opaque).
    spawnCalls.length = 0;
    const denied = await handleGithubProjectsRpc(
      "approve",
      reqMsg(V("approve"), { proposalId }),
      makeCtx({ userId: crypto.randomUUID(), conversationId: "any" }),
    );
    expect("error" in denied && denied.error?.code).toBe(-32603);
    expect(spawnCalls.length).toBe(0);
  });
});
