import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mockDbConnection, setupTestDb, closeTestDb, getTestDb } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent } from "./helpers/mock-request";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockServerAlias();
mock.module("$server/db/queries/memories", () => require("../db/queries/memories"));
mock.module("$server/extensions/audit-actions", () => require("../extensions/audit-actions"));
mock.module("$server/logger", () => require("../logger"));
mock.module("../../web/src/routes/api/memories/$types", () => ({}));
mock.module("../../web/src/routes/api/memories/[id]/$types", () => ({}));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
mock.module("@sveltejs/kit", () => ({ json: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
mock.module("$lib/server/http-errors", () => ({ errorJson: (status: number, error: string) => Response.json({ error }, { status }) }));

const { GET: listMemoriesRoute } = await import("../../web/src/routes/api/memories/+server");
const { GET: getMemoryRoute, PUT: putMemoryRoute, PATCH: patchMemoryRoute, DELETE: deleteMemoryRoute } = await import("../../web/src/routes/api/memories/[id]/+server");
const { getMemoryById, listMemories } = await import("../db/queries/memories");
const { users, projects, projectMembers, conversations, memories, memoryProjects } = await import("../db/schema");

const OWNER = { id: "memory-owner", email: "owner@memory.test", name: "Owner", role: "member" as const, status: "active" as const };
const OTHER = { id: "memory-other", email: "other@memory.test", name: "Other", role: "member" as const, status: "active" as const };
const ADMIN = { id: "memory-admin", email: "admin@memory.test", name: "Admin", role: "admin" as const, status: "active" as const };

beforeEach(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values([OWNER, OTHER, ADMIN].map(user => ({ ...user, passwordHash: "fixture" })));
  await db.insert(projects).values({ id: "memory-project", name: "Memory project", path: "/tmp/memory-project" });
  await db.insert(projectMembers).values([{ projectId: "memory-project", userId: OWNER.id }, { projectId: "memory-project", userId: OTHER.id }]);
  await db.insert(conversations).values({ id: "memory-conversation", projectId: "memory-project", userId: OWNER.id });
  const base = { category: "technical" as const, projectId: "memory-project", confidence: "high" as const, status: "active" as const, injectionEligible: true };
  await db.insert(memories).values([
    { ...base, id: "direct-owner", userId: OWNER.id, content: "DIRECT_OWNER" },
    { ...base, id: "derived-owner", userId: null, conversationId: "memory-conversation", content: "DERIVED_OWNER" },
    { ...base, id: "direct-other", userId: OTHER.id, content: "DIRECT_OTHER" },
    { ...base, id: "direct-other-conversation-owner", userId: OTHER.id, conversationId: "memory-conversation", content: "DIRECT_OTHER_CONVERSATION_OWNER" },
    { ...base, id: "orphan", userId: null, conversationId: null, content: "ORPHAN" },
  ]);
  await db.insert(memoryProjects).values(
    ["direct-owner", "derived-owner", "direct-other", "direct-other-conversation-owner", "orphan"].map(memoryId => ({
      memoryId,
      projectId: "memory-project",
    })),
  );
});

afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });

async function listAs(user: typeof OWNER | typeof ADMIN): Promise<Array<{ id: string; content: string }>> {
  const response = await listMemoriesRoute(createMockEvent({ url: "http://localhost/api/memories?projectId=memory-project", user }) as never);
  expect(response.status).toBe(200);
  return response.json();
}

async function itemAs(
  handler: typeof getMemoryRoute | typeof putMemoryRoute | typeof patchMemoryRoute | typeof deleteMemoryRoute,
  user: typeof OWNER | typeof ADMIN,
  id: string,
  method: "GET" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Response> {
  return handler(createMockEvent({
    method,
    url: `http://localhost/api/memories/${id}`,
    params: { id },
    user,
    body,
  }) as never);
}

test("non-admin memory list includes conversation-derived ownership and excludes other users and orphans", async () => {
  const rows = await listAs(OWNER);
  expect(rows.map(row => row.id).sort()).toEqual(["derived-owner", "direct-owner"]);
  expect(JSON.stringify(rows)).not.toContain("DIRECT_OTHER");
  expect(JSON.stringify(rows)).not.toContain("ORPHAN");
});

test("another user cannot list the conversation-derived memory", async () => {
  const rows = await listAs(OTHER);
  expect(rows.map(row => row.id).sort()).toEqual(["direct-other", "direct-other-conversation-owner"]);
  expect(JSON.stringify(rows)).not.toContain("DERIVED_OWNER");
});

test("admin memory list remains organization-wide", async () => {
  const rows = await listAs(ADMIN);
  expect(rows.map(row => row.id).sort()).toEqual(["derived-owner", "direct-other", "direct-other-conversation-owner", "direct-owner", "orphan"]);
});

test("listMemories gives direct ownership precedence over a source conversation", async () => {
  const ownerRows = await listMemories({ projectId: "memory-project", userId: OWNER.id });
  expect(ownerRows.map(row => row.id).sort()).toEqual(["derived-owner", "direct-owner"]);

  const otherRows = await listMemories({ projectId: "memory-project", userId: OTHER.id });
  expect(otherRows.map(row => row.id).sort()).toEqual(["direct-other", "direct-other-conversation-owner"]);
});

test("scoped getMemoryById derives ownership only for null direct owners", async () => {
  expect((await getMemoryById("derived-owner", OWNER.id))?.id).toBe("derived-owner");
  expect(await getMemoryById("direct-other-conversation-owner", OWNER.id)).toBeUndefined();
  expect(await getMemoryById("orphan", OWNER.id)).toBeUndefined();
  expect((await getMemoryById("direct-other-conversation-owner", OTHER.id))?.id).toBe("direct-other-conversation-owner");
});

test("conversation owner can GET, PUT, PATCH, and DELETE a derived memory", async () => {
  expect((await itemAs(getMemoryRoute, OWNER, "derived-owner", "GET")).status).toBe(200);

  const put = await itemAs(putMemoryRoute, OWNER, "derived-owner", "PUT", { status: "stale" });
  expect(put.status).toBe(200);
  expect((await getMemoryById("derived-owner"))?.status).toBe("stale");

  const patch = await itemAs(patchMemoryRoute, OWNER, "derived-owner", "PATCH", { injectionEligible: false });
  expect(patch.status).toBe(200);
  expect((await getMemoryById("derived-owner"))?.injectionEligible).toBe(false);

  expect((await itemAs(deleteMemoryRoute, OWNER, "derived-owner", "DELETE")).status).toBe(204);
  expect(await getMemoryById("derived-owner")).toBeUndefined();
});

test("non-owners, direct-owner conflicts, and orphans receive 404 without mutation", async () => {
  for (const [user, id] of [
    [OTHER, "derived-owner"],
    [OWNER, "direct-other-conversation-owner"],
  [OWNER, "orphan"],
  ] as const) {
    const before = await getMemoryById(id);
    expect(before).toBeDefined();
    expect((await itemAs(getMemoryRoute, user, id, "GET")).status).toBe(404);
    expect((await itemAs(putMemoryRoute, user, id, "PUT", { status: "stale" })).status).toBe(404);
    expect((await itemAs(patchMemoryRoute, user, id, "PATCH", { injectionEligible: false })).status).toBe(404);
    expect((await itemAs(deleteMemoryRoute, user, id, "DELETE")).status).toBe(404);
    expect(await getMemoryById(id)).toEqual(before);
  }
});

test("admin can manage an orphan memory organization-wide", async () => {
  expect((await itemAs(getMemoryRoute, ADMIN, "orphan", "GET")).status).toBe(200);
  expect((await itemAs(putMemoryRoute, ADMIN, "orphan", "PUT", { status: "stale" })).status).toBe(200);
  expect((await itemAs(patchMemoryRoute, ADMIN, "orphan", "PATCH", { injectionEligible: false })).status).toBe(200);
  expect((await itemAs(deleteMemoryRoute, ADMIN, "orphan", "DELETE")).status).toBe(204);
  expect(await getMemoryById("orphan")).toBeUndefined();
});
