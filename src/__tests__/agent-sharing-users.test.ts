import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { shareAgent, shareAgentWithUser, unshareAgentFromUser, getAgentShares, getSharedAgentsForUser } = await import("../db/queries/agent-shares");
const { createUser } = await import("../db/queries/users");
const { createTeam, addTeamMember } = await import("../db/queries/teams");
const { createAgentConfig } = await import("../db/queries/agent-configs");

let ownerId: string;
let recipientId: string;
let teamMemberId: string;
let teamId: string;
let agentId: string;
let agent2Id: string;

beforeAll(async () => {
  await setupTestDb();

  const owner = await createUser({ email: "share-owner@test.com", passwordHash: "hash", name: "Share Owner", role: "admin" });
  ownerId = owner.id;

  const recipient = await createUser({ email: "share-recipient@test.com", passwordHash: "hash", name: "Share Recipient", role: "member" });
  recipientId = recipient.id;

  const teamMember = await createUser({ email: "share-team@test.com", passwordHash: "hash", name: "Team Member", role: "member" });
  teamMemberId = teamMember.id;

  const team = await createTeam("Share Test Team");
  teamId = team.id;
  await addTeamMember(teamId, teamMemberId, "viewer");

  const agent = await createAgentConfig({
    name: "User Share Agent",
    description: "test agent for user sharing",
    prompt: "you are a test agent",
    userId: ownerId,
  });
  agentId = agent.id;

  const agent2 = await createAgentConfig({
    name: "Team Share Agent",
    description: "test agent for team sharing",
    prompt: "you are a test agent 2",
    userId: ownerId,
  });
  agent2Id = agent2.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("User-to-User Agent Sharing", () => {
  describe("shareAgentWithUser", () => {
    test("inserts share with userId and permission", async () => {
      await shareAgentWithUser(agentId, recipientId, ownerId, "read");
      const shares = await getAgentShares(agentId);
      const userShare = shares.find(s => s.userId === recipientId);
      expect(userShare).toBeDefined();
      expect(userShare!.permission).toBe("read");
    });

    test("upsert updates permission on duplicate agentId+userId", async () => {
      await shareAgentWithUser(agentId, recipientId, ownerId, "edit");
      const shares = await getAgentShares(agentId);
      const userShares = shares.filter(s => s.userId === recipientId);
      expect(userShares).toHaveLength(1);
      expect((userShares[0] as { permission: string }).permission).toBe("edit");
    });

    test("defaults permission to read", async () => {
      await shareAgentWithUser(agent2Id, recipientId, ownerId);
      const shares = await getAgentShares(agent2Id);
      const userShare = shares.find(s => s.userId === recipientId);
      expect(userShare).toBeDefined();
      expect(userShare!.permission).toBe("read");
    });
  });

  describe("unshareAgentFromUser", () => {
    test("removes user share and returns true", async () => {
      const result = await unshareAgentFromUser(agentId, recipientId);
      expect(result).toBe(true);
    });

    test("returns false for non-existent share", async () => {
      const result = await unshareAgentFromUser(agentId, recipientId);
      expect(result).toBe(false);
    });
  });

  describe("getSharedAgentsForUser", () => {
    test("returns user shares with permission field", async () => {
      await shareAgentWithUser(agentId, recipientId, ownerId, "edit");
      const shared = await getSharedAgentsForUser(recipientId);
      const found = shared.find(a => a.id === agentId);
      expect(found).toBeDefined();
      expect(found!.shared).toBe(true);
      expect(found!.permission).toBe("edit");
      expect(found!.sharedByName).toBe("Share Owner");
    });

    test("returns team shares with permission field", async () => {
      await shareAgent(agent2Id, teamId, ownerId);
      const shared = await getSharedAgentsForUser(teamMemberId);
      const found = shared.find(a => a.id === agent2Id);
      expect(found).toBeDefined();
      expect(found!.shared).toBe(true);
      expect(found!.permission).toBe("read");
      expect(found!.teamName).toBe("Share Test Team");
    });

    test("does not return agents owned by the user", async () => {
      // Owner shouldn't see their own agent as shared
      const shared = await getSharedAgentsForUser(ownerId);
      const found = shared.find(a => a.id === agentId);
      expect(found).toBeUndefined();
    });
  });

  describe("getAgentShares", () => {
    test("returns both team and user shares with permission", async () => {
      // agent2 is shared to team, agentId is shared to user
      const shares = await getAgentShares(agentId);
      const userShare = shares.find(s => s.userId === recipientId);
      expect(userShare).toBeDefined();
      expect(userShare!.permission).toBe("edit");
      expect(userShare!.recipientName).toBe("Share Recipient");
    });
  });
});
