/**
 * Agent Sharing Route Integration Tests
 *
 * Tests the SvelteKit route handlers for /api/agents/[id]/share
 * Covers: GET (list shares), POST (share to users/teams), DELETE (unshare)
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// Import route handlers
import { GET as sharesGET, POST as sharesPOST, DELETE as sharesDELETE } from "../../web/src/routes/api/agents/[id]/share/+server";

// DB helpers for setup
import { createUser } from "../db/queries/users";
import { createTeam, addTeamMember } from "../db/queries/teams";
import { createAgentConfig } from "../db/queries/agent-configs";

let OWNER: AuthUser;
let RECIPIENT: AuthUser;
let ADMIN_USER: AuthUser;
let recipientId: string;
let agentId: string;
let teamId: string;

beforeAll(async () => {
  await setupTestDb();

  const owner = await createUser({ email: "share-rt-owner@test.com", passwordHash: "hash", name: "Share Route Owner", role: "member" });
  const recipient = await createUser({ email: "share-rt-recip@test.com", passwordHash: "hash", name: "Share Route Recipient", role: "member" });
  const admin = await createUser({ email: "share-rt-admin@test.com", passwordHash: "hash", name: "Share Route Admin", role: "admin" });

  OWNER = { id: owner.id, email: owner.email, name: owner.name, role: "member" };
  RECIPIENT = { id: recipient.id, email: recipient.email, name: recipient.name, role: "member" };
  ADMIN_USER = { id: admin.id, email: admin.email, name: admin.name, role: "admin" };
  recipientId = recipient.id;

  const team = await createTeam("Share Route Team");
  teamId = team.id;
  await addTeamMember(teamId, owner.id, "editor");

  const agent = await createAgentConfig({
    name: "Route Test Agent",
    description: "test",
    prompt: "you are a test",
    userId: owner.id,
  });
  agentId = agent.id;
});

afterAll(async () => { await closeTestDb(); });

describe("GET /api/agents/[id]/share", () => {
  test("returns 401 when not authenticated", async () => {
    const event = createMockEvent({ params: { id: agentId } });
    const res = await sharesGET(event);
    expect(res.status).toBe(401);
  });

  test("returns 404 for non-existent agent", async () => {
    const event = createMockEvent({ params: { id: "nonexistent-id" }, user: OWNER });
    const res = await sharesGET(event);
    expect(res.status).toBe(404);
  });

  test("returns 404 when user is not owner and not admin", async () => {
    const event = createMockEvent({ params: { id: agentId }, user: RECIPIENT });
    const res = await sharesGET(event);
    expect(res.status).toBe(404);
  });

  test("returns shares array for agent owner", async () => {
    const event = createMockEvent({ params: { id: agentId }, user: OWNER });
    const res = await sharesGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(Array.isArray(data.shares)).toBe(true);
  });

  test("returns shares for admin even if not owner", async () => {
    const event = createMockEvent({ params: { id: agentId }, user: ADMIN_USER });
    const res = await sharesGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(Array.isArray(data.shares)).toBe(true);
  });
});

describe("POST /api/agents/[id]/share", () => {
  test("returns 400 if neither teamIds nor userIds provided", async () => {
    const event = createMockEvent({ method: "POST", params: { id: agentId }, user: OWNER, body: {} });
    const res = await sharesPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("required");
  });

  test("returns 400 if invalid permission value", async () => {
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { userIds: [recipientId], permission: "admin" },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("permission");
  });

  test("returns 404 if target userId does not exist", async () => {
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { userIds: ["nonexistent-user-id"] },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(404);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("not found");
  });

  test("returns 403 if user is viewer on team (not admin)", async () => {
    // Add recipient as viewer on team
    await addTeamMember(teamId, recipientId, "viewer");

    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: RECIPIENT,
      body: { teamIds: [teamId] },
    });
    // Recipient is not agent owner, so verifyOwnerOrAdmin will 404 first
    const res = await sharesPOST(event);
    expect(res.status).toBe(404);
  });

  test("shares to user successfully with default read permission", async () => {
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { userIds: [recipientId] },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);

    // Verify share appears in GET
    const getEvent = createMockEvent({ params: { id: agentId }, user: OWNER });
    const getRes = await sharesGET(getEvent);
    const getData = await jsonFromResponse(getRes);
    expect(getData.shares.length).toBeGreaterThanOrEqual(1);
  });

  test("shares to team successfully", async () => {
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { teamIds: [teamId] },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("shares with edit permission", async () => {
    const recipient2 = await createUser({ email: "share-rt-recip2@test.com", passwordHash: "hash", name: "Recipient 2", role: "member" });
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { userIds: [recipient2.id], permission: "edit" },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("shares to multiple users successfully", async () => {
    const r3 = await createUser({ email: "share-rt-r3@test.com", passwordHash: "hash", name: "R3", role: "member" });
    const r4 = await createUser({ email: "share-rt-r4@test.com", passwordHash: "hash", name: "R4", role: "member" });
    const event = createMockEvent({
      method: "POST", params: { id: agentId }, user: OWNER,
      body: { userIds: [r3.id, r4.id] },
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });
});

describe("DELETE /api/agents/[id]/share", () => {
  test("returns 400 if neither teamId nor userId provided", async () => {
    const event = createMockEvent({ method: "DELETE", params: { id: agentId }, user: OWNER, body: {} });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("required");
  });

  test("removes user share and returns removed: true", async () => {
    const event = createMockEvent({
      method: "DELETE", params: { id: agentId }, user: OWNER,
      body: { userId: recipientId },
    });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
  });

  test("returns removed: false for non-existent share", async () => {
    const event = createMockEvent({
      method: "DELETE", params: { id: agentId }, user: OWNER,
      body: { userId: "nonexistent-user-id" },
    });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(false);
  });

  test("removes team share", async () => {
    const event = createMockEvent({
      method: "DELETE", params: { id: agentId }, user: OWNER,
      body: { teamId },
    });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
  });

  test("returns 404 for non-owner non-admin", async () => {
    const event = createMockEvent({
      method: "DELETE", params: { id: agentId }, user: RECIPIENT,
      body: { userId: recipientId },
    });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(404);
  });
});
