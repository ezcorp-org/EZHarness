import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

mockDbConnection();
mockServerAlias();

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

const { GET: userSearchGET } = await import("../../web/src/routes/api/users/search/+server");
const { shareAgentWithUser, unshareAgentFromUser, getAgentShares, getSharedAgentsForUser } = await import("../db/queries/agent-shares");
const { createUser } = await import("../db/queries/users");
const { createAgentConfig } = await import("../db/queries/agent-configs");

interface TestUser {
  id: string;
  email: string;
  name: string;
}

const searchUsers: TestUser[] = [];
let agentOwnerId: string;
let AUTH_USER: AuthUser;

beforeAll(async () => {
  await setupTestDb();

  // Create 12 users whose names start with "Search" for limit testing
  for (let i = 0; i < 12; i++) {
    const u = await createUser({
      email: `searchuser${i}@test.com`,
      passwordHash: "h",
      name: `Search User ${i}`,
      role: "member",
    });
    searchUsers.push({ id: u.id, email: u.email, name: u.name! });
  }

  // A couple users with distinct names for specificity tests
  const alice = await createUser({ email: "alice@example.com", passwordHash: "h", name: "Alice Wonderland", role: "member" });
  searchUsers.push({ id: alice.id, email: alice.email, name: alice.name! });

  const bob = await createUser({ email: "bob@example.com", passwordHash: "h", name: "Bob Builder", role: "member" });
  searchUsers.push({ id: bob.id, email: bob.email, name: bob.name! });

  const authBase = at(searchUsers, 0, "search user");
  AUTH_USER = { id: authBase.id, email: authBase.email, name: authBase.name, role: "member" };

  // Agent owner for sharing tests
  const owner = await createUser({ email: "agentowner@test.com", passwordHash: "h", name: "Agent Owner", role: "admin" });
  agentOwnerId = owner.id;
});

afterAll(async () => {
  await closeTestDb();
});

// ── Part 1: GET /api/users/search ────────────────────────────────────

describe("GET /api/users/search", () => {
  test("returns empty array when q is missing", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toEqual([]);
  });

  test("returns empty array when q is less than 2 chars", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=a", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toEqual([]);
  });

  test("returns matching users by name (case insensitive)", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=ALICE", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toHaveLength(1);
    expect(data.users[0].name).toBe("Alice Wonderland");
  });

  test("returns matching users by email", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=bob@", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toHaveLength(1);
    expect(data.users[0].email).toBe("bob@example.com");
  });

  test("limits results to 10", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=search", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toHaveLength(10);
  });

  test("requires authentication (no user throws)", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=test" });
    try {
      await userSearchGET(event);
      expect(true).toBe(false); // should not reach
    } catch (e) {
      // requireAuth throws a Response with status 401
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });

  test("returns id, name, email only (no passwordHash)", async () => {
    const event = createMockEvent({ url: "http://localhost/api/users/search?q=alice", user: AUTH_USER });
    const res = await userSearchGET(event);
    const data = await jsonFromResponse(res);
    expect(data.users).toHaveLength(1);
    const keys = Object.keys(data.users[0]);
    expect(keys).toContain("id");
    expect(keys).toContain("name");
    expect(keys).toContain("email");
    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("role");
  });
});

// ── Part 2: Agent sharing query edge cases ───────────────────────────

describe("Agent sharing query edge cases", () => {
  let agentId: string;
  let targetUserId: string;

  beforeAll(async () => {
    const agent = await createAgentConfig({
      name: "Edge Agent",
      description: "for edge case tests",
      prompt: "you are a test agent",
      userId: agentOwnerId,
    });
    agentId = agent.id;
    targetUserId = at(searchUsers, 1, "search user").id;
  });

  test("sharing same agent to same user twice updates permission (upsert)", async () => {
    await shareAgentWithUser(agentId, targetUserId, agentOwnerId, "read");
    await shareAgentWithUser(agentId, targetUserId, agentOwnerId, "edit");

    const shares = await getAgentShares(agentId);
    const userShares = shares.filter((s) => s.userId === targetUserId);
    expect(userShares).toHaveLength(1);
    expect(at(userShares, 0, "user share").permission).toBe("edit");
  });

  test("unsharing non-existent share returns false", async () => {
    const result = await unshareAgentFromUser(agentId, "nonexistent-user-id");
    expect(result).toBe(false);
  });

  test("getSharedAgentsForUser returns empty for user with no shares", async () => {
    // searchUsers[2] has no shares
    const shared = await getSharedAgentsForUser(at(searchUsers, 2, "search user").id);
    expect(shared).toEqual([]);
  });

  test("sharing with edit permission is returned correctly", async () => {
    const shares = await getAgentShares(agentId);
    const userShare = shares.find((s) => s.userId === targetUserId);
    expect(userShare).toBeDefined();
    expect(userShare!.permission).toBe("edit");
    expect(userShare!.sharedByName).toBe("Agent Owner");
  });

  test("multiple agents shared to same user all appear in getSharedAgentsForUser", async () => {
    const agent2 = await createAgentConfig({
      name: "Edge Agent 2",
      description: "second agent",
      prompt: "test",
      userId: agentOwnerId,
    });

    await shareAgentWithUser(agent2.id, targetUserId, agentOwnerId, "read");

    const shared = await getSharedAgentsForUser(targetUserId);
    const ids = shared.map((a) => a.id);
    expect(ids).toContain(agentId);
    expect(ids).toContain(agent2.id);
  });
});
