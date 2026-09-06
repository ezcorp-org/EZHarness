import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mockDbConnection, setupTestDb, closeTestDb, getTestDb } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent } from "./helpers/mock-request";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockServerAlias();
mock.module("$server/db/queries/memories", () => require("../db/queries/memories"));
mock.module("$server/logger", () => require("../logger"));
mock.module("../../web/src/routes/api/memories/$types", () => ({}));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
mock.module("@sveltejs/kit", () => ({ json: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
mock.module("$lib/server/http-errors", () => ({ errorJson: (status: number, error: string) => Response.json({ error }, { status }) }));

const { GET } = await import("../../web/src/routes/api/memories/+server");
const { users, projects, projectMembers, conversations, memories, memoryProjects } = await import("../db/schema");

const OWNER = { id: "memory-owner", email: "owner@memory.test", name: "Owner", role: "member" as const, status: "active" as const };
const OTHER = { id: "memory-other", email: "other@memory.test", name: "Other", role: "member" as const, status: "active" as const };
const ADMIN = { id: "memory-admin", email: "admin@memory.test", name: "Admin", role: "admin" as const, status: "active" as const };

beforeAll(async () => {
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
    { ...base, id: "orphan", userId: null, conversationId: null, content: "ORPHAN" },
  ]);
  await db.insert(memoryProjects).values(
    ["direct-owner", "derived-owner", "direct-other", "orphan"].map(memoryId => ({
      memoryId,
      projectId: "memory-project",
    })),
  );
});

afterAll(async () => { await closeTestDb(); restoreModuleMocks(); });

async function listAs(user: typeof OWNER | typeof ADMIN): Promise<Array<{ id: string; content: string }>> {
  const response = await GET(createMockEvent({ url: "http://localhost/api/memories?projectId=memory-project", user }) as never);
  expect(response.status).toBe(200);
  return response.json();
}

test("non-admin memory list includes conversation-derived ownership and excludes other users and orphans", async () => {
  const rows = await listAs(OWNER);
  expect(rows.map(row => row.id).sort()).toEqual(["derived-owner", "direct-owner"]);
  expect(JSON.stringify(rows)).not.toContain("DIRECT_OTHER");
  expect(JSON.stringify(rows)).not.toContain("ORPHAN");
});

test("another user cannot list the conversation-derived memory", async () => {
  const rows = await listAs(OTHER);
  expect(rows.map(row => row.id)).toEqual(["direct-other"]);
  expect(JSON.stringify(rows)).not.toContain("DERIVED_OWNER");
});

test("admin memory list remains organization-wide", async () => {
  const rows = await listAs(ADMIN);
  expect(rows.map(row => row.id).sort()).toEqual(["derived-owner", "direct-other", "direct-owner", "orphan"]);
});
