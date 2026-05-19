/**
 * Agent Sharing Integration Tests
 *
 * Covers: permission downgrade, team+user dedup, unshare propagation,
 * multi-team sharing, self-share prevention, cascade on delete,
 * sharedByName join, and route-level team+user combined operations.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

mockDbConnection();
mockServerAlias();

import { GET as sharesGET, POST as sharesPOST, DELETE as sharesDELETE } from "../../web/src/routes/api/agents/[id]/share/+server";
import { createUser } from "../db/queries/users";
import { createTeam, addTeamMember } from "../db/queries/teams";
import { createAgentConfig, deleteAgentConfig } from "../db/queries/agent-configs";
import {
  shareAgent,
  shareAgentWithUser,
  unshareAgent,
  getAgentShares,
  getSharedAgentsForUser,
} from "../db/queries/agent-shares";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ── 1. Permission downgrade ──────────────────────────────────────────

describe("Permission downgrade", () => {
  let agentId: string;
  let ownerId: string;
  let targetId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-pd-owner@test.com", passwordHash: "h", name: "PD Owner", role: "member" });
    const target = await createUser({ email: "asi-pd-target@test.com", passwordHash: "h", name: "PD Target", role: "member" });
    ownerId = owner.id;
    targetId = target.id;
    const agent = await createAgentConfig({ name: "PD Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;
  });

  test("sharing with edit then read downgrades permission to read", async () => {
    await shareAgentWithUser(agentId, targetId, ownerId, "edit");
    let shares = await getAgentShares(agentId);
    expect(shares.find(s => s.userId === targetId)!.permission).toBe("edit");

    await shareAgentWithUser(agentId, targetId, ownerId, "read");
    shares = await getAgentShares(agentId);
    const userShares = shares.filter(s => s.userId === targetId);
    expect(userShares).toHaveLength(1);
    expect(at(userShares, 0, "downgraded user share").permission).toBe("read");
  });
});

// ── 2. Team + user dual share deduplication ──────────────────────────

describe("Team + user dual share deduplication", () => {
  let agentId: string;
  let ownerId: string;
  let memberId: string;
  let teamId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-dup-owner@test.com", passwordHash: "h", name: "Dup Owner", role: "member" });
    const member = await createUser({ email: "asi-dup-member@test.com", passwordHash: "h", name: "Dup Member", role: "member" });
    ownerId = owner.id;
    memberId = member.id;

    const team = await createTeam("ASI Dup Team");
    teamId = team.id;
    await addTeamMember(teamId, memberId, "editor");

    const agent = await createAgentConfig({ name: "Dup Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;
  });

  test("getSharedAgentsForUser deduplicates when shared via team AND directly", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");
    await shareAgentWithUser(agentId, memberId, ownerId, "edit");

    const shared = await getSharedAgentsForUser(memberId);
    const matching = shared.filter(a => a.id === agentId);
    expect(matching).toHaveLength(1);
  });
});

// ── 3. Unshare team then verify agent disappears ─────────────────────

describe("Unshare team removes access", () => {
  let agentId: string;
  let ownerId: string;
  let memberId: string;
  let teamId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-ut-owner@test.com", passwordHash: "h", name: "UT Owner", role: "member" });
    const member = await createUser({ email: "asi-ut-member@test.com", passwordHash: "h", name: "UT Member", role: "member" });
    ownerId = owner.id;
    memberId = member.id;

    const team = await createTeam("ASI Unshare Team");
    teamId = team.id;
    await addTeamMember(teamId, memberId, "editor");

    const agent = await createAgentConfig({ name: "UT Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;
  });

  test("share to team, verify visible, unshare, verify gone", async () => {
    await shareAgent(agentId, teamId, ownerId, "read");

    let shared = await getSharedAgentsForUser(memberId);
    expect(shared.some(a => a.id === agentId)).toBe(true);

    await unshareAgent(agentId, teamId);

    shared = await getSharedAgentsForUser(memberId);
    expect(shared.some(a => a.id === agentId)).toBe(false);
  });
});

// ── 4. Share to multiple teams ───────────────────────────────────────

describe("Share to multiple teams", () => {
  let agentId: string;
  let ownerId: string;
  let member1Id: string;
  let member2Id: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-mt-owner@test.com", passwordHash: "h", name: "MT Owner", role: "member" });
    const m1 = await createUser({ email: "asi-mt-m1@test.com", passwordHash: "h", name: "MT Member1", role: "member" });
    const m2 = await createUser({ email: "asi-mt-m2@test.com", passwordHash: "h", name: "MT Member2", role: "member" });
    ownerId = owner.id;
    member1Id = m1.id;
    member2Id = m2.id;

    const team1 = await createTeam("ASI Multi Team 1");
    const team2 = await createTeam("ASI Multi Team 2");
    await addTeamMember(team1.id, member1Id, "editor");
    await addTeamMember(team2.id, member2Id, "editor");

    const agent = await createAgentConfig({ name: "MT Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;

    await shareAgent(agentId, team1.id, ownerId, "read");
    await shareAgent(agentId, team2.id, ownerId, "edit");
  });

  test("member of team1 sees the agent", async () => {
    const shared = await getSharedAgentsForUser(member1Id);
    expect(shared.some(a => a.id === agentId)).toBe(true);
  });

  test("member of team2 sees the agent", async () => {
    const shared = await getSharedAgentsForUser(member2Id);
    expect(shared.some(a => a.id === agentId)).toBe(true);
  });
});

// ── 5. Owner cannot share to themselves ──────────────────────────────

describe("Owner cannot share to themselves", () => {
  let agentId: string;
  let OWNER: AuthUser;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-self-owner@test.com", passwordHash: "h", name: "Self Owner", role: "member" });
    OWNER = { id: owner.id, email: owner.email, name: owner.name, role: "member" };
    const agent = await createAgentConfig({ name: "Self Agent", description: "test", prompt: "test", userId: owner.id });
    agentId = agent.id;
  });

  test("sharing agent to owner's own userId does not appear in getSharedAgentsForUser", async () => {
    // The route doesn't explicitly block self-sharing, but getSharedAgentsForUser
    // filters out agents where userId === owner (ac.user_id != $userId)
    await shareAgentWithUser(agentId, OWNER.id, OWNER.id, "read");

    const shared = await getSharedAgentsForUser(OWNER.id);
    expect(shared.some(a => a.id === agentId)).toBe(false);
  });
});

// ── 6. Delete agent cascades shares ──────────────────────────────────

describe("Delete agent cascades shares", () => {
  let agentId: string;
  let ownerId: string;
  let targetId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-del-owner@test.com", passwordHash: "h", name: "Del Owner", role: "member" });
    const target = await createUser({ email: "asi-del-target@test.com", passwordHash: "h", name: "Del Target", role: "member" });
    ownerId = owner.id;
    targetId = target.id;

    const agent = await createAgentConfig({ name: "Del Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;

    await shareAgentWithUser(agentId, targetId, ownerId, "read");
  });

  test("after deleting agent, getAgentShares returns empty", async () => {
    // Verify share exists first
    let shares = await getAgentShares(agentId);
    expect(shares.length).toBeGreaterThanOrEqual(1);

    await deleteAgentConfig(agentId);

    shares = await getAgentShares(agentId);
    expect(shares).toHaveLength(0);
  });

  test("after deleting agent, getSharedAgentsForUser no longer includes it", async () => {
    const shared = await getSharedAgentsForUser(targetId);
    expect(shared.some(a => a.id === agentId)).toBe(false);
  });
});

// ── 7. getAgentShares returns sharedByName ───────────────────────────

describe("getAgentShares returns sharedByName", () => {
  let agentId: string;
  let ownerId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-sbn-owner@test.com", passwordHash: "h", name: "Sharer NameTest", role: "member" });
    const target = await createUser({ email: "asi-sbn-target@test.com", passwordHash: "h", name: "Recipient NameTest", role: "member" });
    ownerId = owner.id;

    const agent = await createAgentConfig({ name: "SBN Agent", description: "test", prompt: "test", userId: ownerId });
    agentId = agent.id;

    await shareAgentWithUser(agentId, target.id, ownerId, "edit");
  });

  test("sharedByName matches the sharer's user name", async () => {
    const shares = await getAgentShares(agentId);
    expect(shares).toHaveLength(1);
    const share = at(shares, 0, "sharedByName share");
    expect(share.sharedByName).toBe("Sharer NameTest");
    expect(share.recipientName).toBe("Recipient NameTest");
    expect(share.permission).toBe("edit");
  });
});

// ── 8. Route: GET shares includes both team and user shares ──────────

describe("Route: GET returns team and user shares", () => {
  let agentId: string;
  let OWNER: AuthUser;
  let teamId: string;
  let recipientId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-rget-owner@test.com", passwordHash: "h", name: "RGet Owner", role: "member" });
    const recipient = await createUser({ email: "asi-rget-recip@test.com", passwordHash: "h", name: "RGet Recip", role: "member" });
    OWNER = { id: owner.id, email: owner.email, name: owner.name, role: "member" };
    recipientId = recipient.id;

    const team = await createTeam("ASI RGet Team");
    teamId = team.id;
    await addTeamMember(teamId, owner.id, "editor");

    const agent = await createAgentConfig({ name: "RGet Agent", description: "test", prompt: "test", userId: owner.id });
    agentId = agent.id;

    // Share to both team and user
    await shareAgent(agentId, teamId, owner.id, "read");
    await shareAgentWithUser(agentId, recipientId, owner.id, "edit");
  });

  test("GET returns both team share and user share", async () => {
    const event = createMockEvent({ params: { id: agentId }, user: OWNER });
    const res = await sharesGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);

    expect(data.shares).toHaveLength(2);

    const teamShare = data.shares.find((s: any) => s.teamId != null);
    const userShare = data.shares.find((s: any) => s.userId != null);

    expect(teamShare).toBeDefined();
    expect(teamShare.teamId).toBe(teamId);
    expect(teamShare.permission).toBe("read");

    expect(userShare).toBeDefined();
    expect(userShare.userId).toBe(recipientId);
    expect(userShare.permission).toBe("edit");
  });
});

// ── 9. Route: DELETE team share ──────────────────────────────────────

describe("Route: DELETE team share", () => {
  let agentId: string;
  let OWNER: AuthUser;
  let teamId: string;

  beforeAll(async () => {
    const owner = await createUser({ email: "asi-rdel-owner@test.com", passwordHash: "h", name: "RDel Owner", role: "member" });
    OWNER = { id: owner.id, email: owner.email, name: owner.name, role: "member" };

    const team = await createTeam("ASI RDel Team");
    teamId = team.id;
    await addTeamMember(teamId, owner.id, "editor");

    const agent = await createAgentConfig({ name: "RDel Agent", description: "test", prompt: "test", userId: owner.id });
    agentId = agent.id;
  });

  test("POST share to team, DELETE with teamId, verify removed", async () => {
    // Share to team via route
    const postEvent = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { teamIds: [teamId] },
    });
    const postRes = await sharesPOST(postEvent);
    expect(postRes.status).toBe(200);

    // Verify share exists
    let getEvent = createMockEvent({ params: { id: agentId }, user: OWNER });
    let getRes = await sharesGET(getEvent);
    let getData = await jsonFromResponse(getRes);
    expect(getData.shares.some((s: any) => s.teamId === teamId)).toBe(true);

    // Delete team share via route
    const delEvent = createMockEvent({
      method: "DELETE", params: { id: agentId }, user: OWNER,
      body: { teamId },
    });
    const delRes = await sharesDELETE(delEvent);
    expect(delRes.status).toBe(200);
    const delData = await jsonFromResponse(delRes);
    expect(delData.ok).toBe(true);
    expect(delData.removed).toBe(true);

    // Verify share is gone
    getEvent = createMockEvent({ params: { id: agentId }, user: OWNER });
    getRes = await sharesGET(getEvent);
    getData = await jsonFromResponse(getRes);
    expect(getData.shares.some((s: any) => s.teamId === teamId)).toBe(false);
  });
});
