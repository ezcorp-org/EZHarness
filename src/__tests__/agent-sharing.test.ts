import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

const { shareAgent, unshareAgent, getAgentShares, getSharedAgentsForUser } = await import("../db/queries/agent-shares");
const { createUser } = await import("../db/queries/users");
const { createTeam, addTeamMember } = await import("../db/queries/teams");
const { createAgentConfig, listAgentConfigs, updateAgentConfig } = await import("../db/queries/agent-configs");
const { insertAuditEntry, listAuditLog } = await import("../db/queries/audit-log");

let ownerId: string;
let memberId: string;
let teamId: string;
let agentId: string;

beforeAll(async () => {
  await setupTestDb();

  const owner = await createUser({ email: "owner@test.com", passwordHash: "hash", name: "Owner User", role: "admin" });
  ownerId = owner.id;

  const member = await createUser({ email: "member@test.com", passwordHash: "hash", name: "Member User", role: "member" });
  memberId = member.id;

  const team = await createTeam("Test Team");
  teamId = team.id;

  await addTeamMember(teamId, ownerId, "owner");
  await addTeamMember(teamId, memberId, "viewer");

  const agent = await createAgentConfig({
    name: "Test Agent",
    description: "test",
    prompt: "you are a test agent",
    userId: ownerId,
  });
  agentId = agent.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("Agent Sharing", () => {
  describe("Share mechanics", () => {
    test("shareAgent succeeds without error", async () => {
      await shareAgent(agentId, teamId, ownerId);
      // no error thrown means success
    });

    test("shareAgent is idempotent (ON CONFLICT DO NOTHING)", async () => {
      // sharing the same agent+team again should not throw
      await shareAgent(agentId, teamId, ownerId);
      const shares = await getAgentShares(agentId);
      // still only one share, not duplicated
      expect(shares).toHaveLength(1);
    });

    test("getAgentShares returns share with teamName and sharedByName", async () => {
      const shares = await getAgentShares(agentId);
      expect(shares).toHaveLength(1);
      const share = at(shares, 0, "agent share");
      expect(share.teamId).toBe(teamId);
      expect(share.teamName).toBe("Test Team");
      expect(share.sharedBy).toBe(ownerId);
      expect(share.sharedByName).toBe("Owner User");
      expect(share.createdAt).toBeInstanceOf(Date);
    });

    test("getSharedAgentsForUser returns the shared agent for team member", async () => {
      const shared = await getSharedAgentsForUser(memberId);
      expect(shared.length).toBeGreaterThanOrEqual(1);
      const found = shared.find((a) => a.id === agentId);
      expect(found).toBeDefined();
    });

    test("shared agent has shared: true and correct sharedByName", async () => {
      const shared = await getSharedAgentsForUser(memberId);
      const found = shared.find((a) => a.id === agentId)!;
      expect(found.shared).toBe(true);
      expect(found.sharedByName).toBe("Owner User");
      expect(found.teamName).toBe("Test Team");
    });
  });

  describe("Unshare mechanics", () => {
    test("unshareAgent returns true for existing share", async () => {
      // Ensure shared first
      await shareAgent(agentId, teamId, ownerId);
      const result = await unshareAgent(agentId, teamId);
      expect(result).toBe(true);
    });

    test("after unshare, getAgentShares returns empty array", async () => {
      const shares = await getAgentShares(agentId);
      expect(shares).toEqual([]);
    });

    test("after unshare, getSharedAgentsForUser no longer includes the agent", async () => {
      const shared = await getSharedAgentsForUser(memberId);
      const found = shared.find((a) => a.id === agentId);
      expect(found).toBeUndefined();
    });

    test("unshareAgent returns false for non-existent share", async () => {
      const result = await unshareAgent(agentId, teamId);
      expect(result).toBe(false);
    });
  });

  describe("Visibility via listAgentConfigs", () => {
    beforeAll(async () => {
      // Re-share for visibility tests
      await shareAgent(agentId, teamId, ownerId);
    });

    test("listAgentConfigs(ownerId) returns owned agent with shared: false", async () => {
      const configs = await listAgentConfigs(ownerId);
      const owned = configs.find((c) => c.id === agentId);
      expect(owned).toBeDefined();
      expect(owned!.shared).toBe(false);
    });

    test("listAgentConfigs(memberId) returns shared agent with shared: true", async () => {
      const configs = await listAgentConfigs(memberId);
      const shared = configs.find((c) => c.id === agentId);
      expect(shared).toBeDefined();
      expect(shared!.shared).toBe(true);
      expect(shared!.sharedByName).toBe("Owner User");
    });

    test("owner edits are visible to shared users (reference model)", async () => {
      await updateAgentConfig(agentId, { description: "updated description" });

      const configs = await listAgentConfigs(memberId);
      const shared = configs.find((c) => c.id === agentId);
      expect(shared).toBeDefined();
      expect(shared!.description).toBe("updated description");
    });
  });

  describe("Audit logging", () => {
    test("insertAuditEntry records agent:shared action", async () => {
      await insertAuditEntry(ownerId, "agent:shared", agentId, { teamIds: [teamId] });
      const entries = await listAuditLog();
      const entry = entries.find((e) => e.action === "agent:shared" && e.target === agentId);
      expect(entry).toBeDefined();
      expect(entry!.userId).toBe(ownerId);
      expect((entry!.metadata as any).teamIds).toEqual([teamId]);
    });

    test("listAuditLog returns entries ordered by createdAt DESC", async () => {
      await insertAuditEntry(ownerId, "agent:unshared", agentId, { teamIds: [teamId] });
      const entries = await listAuditLog();
      expect(entries.length).toBeGreaterThanOrEqual(2);
      // Most recent first
      for (let i = 1; i < entries.length; i++) {
        const prev = at(entries, i - 1, "audit entry");
        const curr = at(entries, i, "audit entry");
        expect(prev.createdAt.getTime()).toBeGreaterThanOrEqual(curr.createdAt.getTime());
      }
    });

    test("listAuditLog filters by action", async () => {
      const entries = await listAuditLog({ action: "agent:shared" });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      for (const e of entries) {
        expect(e.action).toBe("agent:shared");
      }
    });

    test("listAuditLog respects limit", async () => {
      const entries = await listAuditLog({ limit: 1 });
      expect(entries).toHaveLength(1);
    });
  });
});
