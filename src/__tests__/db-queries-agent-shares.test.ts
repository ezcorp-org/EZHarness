import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  shareAgent,
  shareAgentWithUser,
  unshareAgent,
  unshareAgentFromUser,
  getAgentShares,
  getSharedAgentsForUser,
} = await import("../db/queries/agent-shares");
const { createUser } = await import("../db/queries/users");
const { createTeam, addTeamMember } = await import("../db/queries/teams");
const { createAgentConfig } = await import("../db/queries/agent-configs");

describe("agent-shares queries", () => {
  let ownerId: string;
  let recipientId: string;
  let teamId: string;
  let agentId: string;

  beforeEach(async () => {
    await setupTestDb();
    ownerId = (await createUser({ email: "owner@test.com", passwordHash: "h", name: "Owner" })).id;
    recipientId = (await createUser({ email: "recv@test.com", passwordHash: "h", name: "Recv" })).id;
    const team = await createTeam("devs");
    teamId = team.id;
    await addTeamMember(teamId, recipientId, "viewer");
    const agent = await createAgentConfig({
      name: "shared-agent",
      description: "d",
      prompt: "p",
      userId: ownerId,
    });
    agentId = agent.id;
  });
  afterAll(async () => await closeTestDb());

  test("shareAgent inserts a team share row", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    const shares = await getAgentShares(agentId);
    expect(shares.length).toBe(1);
    expect(shares[0]!.teamId).toBe(teamId);
    expect(shares[0]!.teamName).toBe("devs");
    expect(shares[0]!.userId).toBeNull();
    expect(shares[0]!.sharedBy).toBe(ownerId);
    expect(shares[0]!.sharedByName).toBe("Owner");
    expect(shares[0]!.permission).toBe("read");
  });

  test("shareAgent upserts — re-sharing updates permission (no duplicate)", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    await shareAgent(agentId, teamId, ownerId, "edit");

    const shares = await getAgentShares(agentId);
    expect(shares.length).toBe(1);
    expect(shares[0]!.permission).toBe("edit");
  });

  test("shareAgentWithUser inserts a direct user share", async () => {
    await shareAgentWithUser(agentId, recipientId, ownerId, "edit");
    const shares = await getAgentShares(agentId);
    expect(shares.length).toBe(1);
    expect(shares[0]!.userId).toBe(recipientId);
    expect(shares[0]!.recipientName).toBe("Recv");
    expect(shares[0]!.teamId).toBeNull();
    expect(shares[0]!.permission).toBe("edit");
  });

  test("unshareAgent removes the team share, false when no match", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    expect(await unshareAgent(agentId, teamId)).toBe(true);
    expect((await getAgentShares(agentId)).length).toBe(0);
    expect(await unshareAgent(agentId, teamId)).toBe(false);
  });

  test("unshareAgentFromUser removes only the user share", async () => {
    await shareAgentWithUser(agentId, recipientId, ownerId, "read");
    expect(await unshareAgentFromUser(agentId, recipientId)).toBe(true);
    expect(await unshareAgentFromUser(agentId, recipientId)).toBe(false);
  });

  test("getAgentShares returns empty for unshared agent", async () => {
    expect(await getAgentShares(agentId)).toEqual([]);
  });

  test("getSharedAgentsForUser finds agents via team membership", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    const agents = await getSharedAgentsForUser(recipientId);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe(agentId);
    expect(agents[0]!.shared).toBe(true);
    expect(agents[0]!.permission).toBe("read");
    expect(agents[0]!.teamId).toBe(teamId);
  });

  test("getSharedAgentsForUser finds directly-shared agents", async () => {
    await shareAgentWithUser(agentId, recipientId, ownerId, "edit");
    const agents = await getSharedAgentsForUser(recipientId);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe(agentId);
    expect(agents[0]!.permission).toBe("edit");
    expect(agents[0]!.teamId).toBeNull();
  });

  test("getSharedAgentsForUser excludes owner's own agents", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    // Owner is not a member of the team, but even if they were, the WHERE
    // clause `ac.user_id != userId` excludes their own agents.
    await addTeamMember(teamId, ownerId, "owner");
    const agents = await getSharedAgentsForUser(ownerId);
    expect(agents.length).toBe(0);
  });

  test("getSharedAgentsForUser deduplicates when agent is shared via multiple paths", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    await shareAgentWithUser(agentId, recipientId, ownerId, "edit");
    const agents = await getSharedAgentsForUser(recipientId);
    expect(agents.length).toBe(1);
  });
});
