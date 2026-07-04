// Coverage companion for src/extensions/github-projects-handler.ts.
//
// The main unit suite always substitutes the links-by-user source via
// `_setLinksByUserForTests(...)`, so the DEFAULT `defaultLinksByUser` impl (the
// real-DB fallback) never runs there — and the coverage leg runs UNIT shards
// only (the integration suite isn't in it), leaving those lines uncovered.
//
// This small file exercises the DEFAULT impl: real PGlite + real query layer +
// the real `getDb()`-backed `defaultLinksByUser`, with client/spawn stubbed so
// nothing touches the network or `gh`. `dashboard-data` never resolves auth, so
// no secrets-store stub is needed here. A `github_projects_links` row is seeded
// via the REAL `upsertLink` query whose `createdByUserId` matches the ctx
// userId; `dashboard-data` then returns it.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { GithubClient, GithubFetchPage } from "../../integrations/github-projects/types";
import type { GithubProjectsProposal } from "../../db/schema";

// Real getDb() → test PGlite (the real query layer + defaultLinksByUser read
// through this).
mockDbConnection();

// In-file restore pattern (mock-cleanup-coverage): client + spawn are NOT in
// MODULE_PATHS, so snapshot the real exports before stubbing and re-register
// them in afterAll (also stops the stubs leaking into sibling test files).
const REAL_CLIENT = { ...(await import("../../integrations/github-projects/client")) };
const REAL_SPAWN = { ...(await import("../../integrations/github-projects/spawn")) };

mock.module("../../integrations/github-projects/client", () => ({
  createGithubClient: (): GithubClient => ({
    resolveBoardFromUrl: async () => ({
      boardNodeId: "PVT_db",
      title: "DB Board",
      ownerLogin: "acme",
      statusFieldId: "FIELD",
      statusOptions: [],
    }),
    validateAuth: async () => ({ ok: true, scopes: [], missingScopes: [] }),
    fetchBoardItems: async (): Promise<GithubFetchPage> => ({ items: [], cursor: {} }),
    createIssueOnBoard: async () => ({ itemNodeId: "x", contentNodeId: null, url: null, title: "x" }),
    updateItem: async () => ({ itemNodeId: "x", contentNodeId: null, url: null, title: "x" }),
    setItemStatus: async () => undefined,
    archiveItem: async () => undefined,
    addComment: async () => undefined,
  }),
}));
mock.module("../../integrations/github-projects/spawn", () => ({
  approveProposal: async (id: string) => ({ id, status: "spawned" } as GithubProjectsProposal),
  dismissProposal: async (id: string) => ({ id, status: "dismissed" } as GithubProjectsProposal),
}));

const { handleGithubProjectsRpc, _setLinksByUserForTests } = await import(
  "../github-projects-handler"
);
const { GITHUB_PROJECTS_RPC_PREFIX } = await import("../../integrations/github-projects/types");
const { upsertLink } = await import("../../db/queries/github-projects");
// Deny-by-default extension RBAC: the member viewer needs a real `use` grant
// or dashboard-data returns the empty permissionDenied shape instead of rows.
const { upsertGrant } = await import("../../db/queries/extension-rbac");

afterAll(() => {
  mock.module("../../integrations/github-projects/client", () => REAL_CLIENT);
  mock.module("../../integrations/github-projects/spawn", () => REAL_SPAWN);
  restoreModuleMocks();
});

beforeAll(async () => {
  await setupTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(() => {
  // Use the DEFAULT links-by-user impl (the real `getDb()`-backed query) — the
  // whole point of this file.
  _setLinksByUserForTests(null);
});

describe("dashboard-data — default links-by-user impl (real DB)", () => {
  test("returns the viewing user's board via the real getDb() query", async () => {
    const { getDb } = await import("../../db/connection");
    const db = getDb();
    const schema = await import("../../db/schema");
    const userId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email: `u${userId.slice(0, 8)}@x.test`,
      passwordHash: "x",
      name: "DB User",
      role: "member",
    });
    await db.insert(schema.projects).values({ id: projectId, name: "P", path: "/tmp/p" });
    // Deny-by-default RBAC: grant the member viewer `use` (all projects /
    // all extensions — NULL coordinates need no extensions-table FK parent).
    await upsertGrant({
      userId,
      projectId: null,
      extensionId: null,
      scopes: ["use"],
      grantedByUserId: null,
    });

    // Seed the link via the REAL upsertLink query, with createdByUserId = ctx user.
    const link = await upsertLink({
      projectId,
      boardNodeId: "PVT_db",
      boardUrl: "https://github.com/orgs/acme/projects/3",
      boardTitle: "DB Board",
      ownerLogin: "acme",
      authMode: "pat",
      createdByUserId: userId,
    });

    const res = await handleGithubProjectsRpc(
      "dashboard-data",
      { jsonrpc: "2.0" as const, id: 1, method: `${GITHUB_PROJECTS_RPC_PREFIX}dashboard-data`, params: {} },
      {
        extensionName: "github-projects",
        extensionId: "ext-gp",
        userId,
        conversationId: "any",
        grantedPermissions: { grantedAt: {} },
      },
    );

    expect("result" in res).toBe(true);
    const data = (res as { result: { boards: { linkId: string; boardTitle: string }[] } }).result;
    expect(data.boards.map((b) => b.linkId)).toEqual([link.id]);
    expect(data.boards[0]!.boardTitle).toBe("DB Board");
  });

  test("another user's board does NOT appear (real-query owner scoping)", async () => {
    const { getDb } = await import("../../db/connection");
    const db = getDb();
    const schema = await import("../../db/schema");
    const ownerId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    for (const id of [ownerId, viewerId]) {
      await db.insert(schema.users).values({
        id,
        email: `u${id.slice(0, 8)}@x.test`,
        passwordHash: "x",
        name: "U",
        role: "member",
      });
    }
    await db.insert(schema.projects).values({ id: projectId, name: "P2", path: "/tmp/p2" });
    await upsertLink({
      projectId,
      boardNodeId: "PVT_other",
      boardUrl: "https://github.com/orgs/acme/projects/4",
      boardTitle: "Owner Board",
      ownerLogin: "acme",
      authMode: "pat",
      createdByUserId: ownerId,
    });

    const res = await handleGithubProjectsRpc(
      "dashboard-data",
      { jsonrpc: "2.0" as const, id: 1, method: `${GITHUB_PROJECTS_RPC_PREFIX}dashboard-data`, params: {} },
      {
        extensionName: "github-projects",
        extensionId: "ext-gp",
        userId: viewerId, // not the owner
        conversationId: "any",
        grantedPermissions: { grantedAt: {} },
      },
    );

    expect("result" in res).toBe(true);
    const data = (res as { result: { boards: unknown[] } }).result;
    // The default real query filters by createdByUserId → viewer sees nothing.
    expect(data.boards).toEqual([]);
  });
});
