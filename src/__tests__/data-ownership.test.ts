import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

import { createUser } from "../db/queries/users";
import { listConversations, createConversation } from "../db/queries/conversations";
import { listAgentConfigs, createAgentConfig } from "../db/queries/agent-configs";
import { shareAgent, unshareAgent } from "../db/queries/agent-shares";
import { createTeam, addTeamMember } from "../db/queries/teams";
import { projects, conversations, agentConfigs, agentShares, teams, teamMembers } from "../db/schema";

let userA: { id: string; email: string; name: string; role: "admin" | "member" };
let userB: { id: string; email: string; name: string; role: "admin" | "member" };
let userC: { id: string; email: string; name: string; role: "admin" | "member" };
const projectId = "test-project-001";

beforeAll(async () => {
  await setupTestDb();
  // Create the project that conversations reference via FK
  await getTestDb().insert(projects).values({ id: projectId, name: "Test Project", path: "/tmp/test" });
  userA = await createUser({ email: "a@test.local", passwordHash: "hash", name: "User A", role: "member" });
  userB = await createUser({ email: "b@test.local", passwordHash: "hash", name: "User B", role: "member" });
  userC = await createUser({ email: "c@test.local", passwordHash: "hash", name: "User C", role: "member" });
});

afterAll(async () => { await closeTestDb(); });

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(agentShares);
  await db.delete(teamMembers);
  await db.delete(teams);
  await db.delete(agentConfigs);
  await db.delete(conversations);
});

// ── Conversation Isolation ──────────────────────────────────────────

describe("conversation isolation", () => {
  test("owner can see their own conversation", async () => {
    await createConversation(projectId, { title: "A's convo", userId: userA.id });

    const result = await listConversations(projectId, userA.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("A's convo");
  });

  test("user B cannot see user A's conversation", async () => {
    await createConversation(projectId, { title: "A's private", userId: userA.id });

    const result = await listConversations(projectId, userB.id);
    expect(result).toHaveLength(0);
  });

  test("conversations without userId are visible when listing without userId filter", async () => {
    await createConversation(projectId, { title: "Legacy convo" });
    await createConversation(projectId, { title: "A's convo", userId: userA.id });

    // No userId filter returns all non-test conversations
    const all = await listConversations(projectId);
    expect(all).toHaveLength(2);

    // userA sees only their own
    const forA = await listConversations(projectId, userA.id);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.title).toBe("A's convo");
  });
});

// ── Agent Config Isolation ──────────────────────────────────────────

describe("agent config isolation", () => {
  test("owner can see their own agent config", async () => {
    await createAgentConfig({ name: "A-Agent", description: "test", prompt: "do stuff", userId: userA.id });

    const result = await listAgentConfigs(userA.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("A-Agent");
  });

  test("user B cannot see user A's agent config", async () => {
    await createAgentConfig({ name: "A-Agent", description: "test", prompt: "do stuff", userId: userA.id });

    const result = await listAgentConfigs(userB.id);
    expect(result).toHaveLength(0);
  });

  test("listAgentConfigs without userId returns ALL agents (admin view)", async () => {
    await createAgentConfig({ name: "A-Agent", description: "test", prompt: "do stuff", userId: userA.id });
    await createAgentConfig({ name: "B-Agent", description: "test", prompt: "do stuff", userId: userB.id });

    const all = await listAgentConfigs();
    expect(all).toHaveLength(2);
  });
});

// ── Agent Sharing ───────────────────────────────────────────────────

describe("agent sharing", () => {
  test("shared agent is visible to team member", async () => {
    const agent = await createAgentConfig({ name: "Shared-Agent", description: "test", prompt: "shared", userId: userA.id });
    const team = await createTeam("Test Team");
    await addTeamMember(team.id, userB.id, "editor");
    await shareAgent(agent.id, team.id, userA.id);

    const result = await listAgentConfigs(userB.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Shared-Agent");
    expect(result[0]!.shared).toBe(true);
    expect(result[0]!.sharedBy).toBe(userA.id);
    expect(result[0]!.sharedByName).toBe("User A");
  });

  test("non-team-member cannot see shared agent", async () => {
    const agent = await createAgentConfig({ name: "Shared-Agent", description: "test", prompt: "shared", userId: userA.id });
    const team = await createTeam("Test Team");
    await addTeamMember(team.id, userB.id, "editor");
    await shareAgent(agent.id, team.id, userA.id);

    // userC is NOT a team member
    const result = await listAgentConfigs(userC.id);
    expect(result).toHaveLength(0);
  });

  test("owner sees own agent without duplication when shared to their team", async () => {
    const agent = await createAgentConfig({ name: "My-Agent", description: "test", prompt: "mine", userId: userA.id });
    const team = await createTeam("Owner Team");
    await addTeamMember(team.id, userA.id, "owner");
    await addTeamMember(team.id, userB.id, "editor");
    await shareAgent(agent.id, team.id, userA.id);

    const result = await listAgentConfigs(userA.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("My-Agent");
    // Owner's copy should not be marked as shared
    expect(result[0]!.shared).toBe(false);
  });

  test("unsharing removes visibility for team member", async () => {
    const agent = await createAgentConfig({ name: "Temp-Shared", description: "test", prompt: "temp", userId: userA.id });
    const team = await createTeam("Temp Team");
    await addTeamMember(team.id, userB.id, "viewer");
    await shareAgent(agent.id, team.id, userA.id);

    // Verify userB can see it
    let result = await listAgentConfigs(userB.id);
    expect(result).toHaveLength(1);

    // Unshare
    await unshareAgent(agent.id, team.id);

    result = await listAgentConfigs(userB.id);
    expect(result).toHaveLength(0);
  });
});

// ── Cross-user Isolation ────────────────────────────────────────────

describe("cross-user isolation", () => {
  test("multiple users each only see their own conversations", async () => {
    const testUsers = [userA, userB, userC];
    for (const u of testUsers) {
      await createConversation(projectId, { title: `${u.name} convo`, userId: u.id });
    }

    for (const u of testUsers) {
      const result = await listConversations(projectId, u.id);
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe(`${u.name} convo`);
      expect(result[0]!.userId).toBe(u.id);
    }
  });

  test("multiple users each only see their own agents plus shared agents", async () => {
    const agentA = await createAgentConfig({ name: "Agent-A", description: "test", prompt: "a", userId: userA.id });
    await createAgentConfig({ name: "Agent-B", description: "test", prompt: "b", userId: userB.id });
    await createAgentConfig({ name: "Agent-C", description: "test", prompt: "c", userId: userC.id });

    // Share A's agent with a team containing B
    const team = await createTeam("AB Team");
    await addTeamMember(team.id, userB.id, "editor");
    await shareAgent(agentA.id, team.id, userA.id);

    // A sees only their own agent
    const forA = await listAgentConfigs(userA.id);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.name).toBe("Agent-A");

    // B sees their own agent + A's shared agent
    const forB = await listAgentConfigs(userB.id);
    expect(forB).toHaveLength(2);
    const names = forB.map((a) => a.name).sort();
    expect(names).toEqual(["Agent-A", "Agent-B"]);

    // C sees only their own agent
    const forC = await listAgentConfigs(userC.id);
    expect(forC).toHaveLength(1);
    expect(forC[0]!.name).toBe("Agent-C");
  });
});
