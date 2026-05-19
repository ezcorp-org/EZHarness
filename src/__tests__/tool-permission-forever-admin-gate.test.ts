/**
 * Phase 4 (capability-expiry) — server-side defense-in-depth gate test.
 *
 * The PermissionGate's expired branch surfaces an "Approve forever
 * (admin only)" button to admin users only (UI gate). This test
 * exercises the SERVER-SIDE gate that catches a tampered DOM (or a
 * hand-rolled curl) posting `{approved: true, scope: "forever"}` from
 * a non-admin session. The handler must reject 403 BEFORE resolving
 * the gate, so the always-allow `forever` row never lands.
 *
 * Other scopes (`session`, `conversation`, `project`) remain open to
 * any authenticated caller — those are per-user trust decisions on a
 * grant the install-time admin already approved.
 */

import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AuthUser } from "../auth/types";

afterAll(() => restoreModuleMocks());

let settingsStore: Record<string, unknown> = {};

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => settingsStore[key],
  upsertSetting: async (key: string, value: unknown) => {
    settingsStore[key] = value;
  },
}));

mock.module("../db/queries/conversations", () => ({
  getConversation: async (_id: string) => ({
    id: "conv-owner",
    userId: "owner-user-1",
    title: "Owner conversation",
    projectId: null,
  }),
}));

import { handleToolPermission } from "../routes/tool-permission";
import { createPermissionGate, getPendingApproval } from "../runtime/tools/permissions";

const ADMIN_USER: AuthUser = {
  id: "admin-1",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

const MEMBER_OWNER: AuthUser = {
  id: "owner-user-1",
  email: "owner@test.local",
  name: "Owner",
  role: "member",
};

function postPermission(id: string, body: unknown) {
  return new Request(`http://localhost/api/tool-calls/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  settingsStore = {};
});

describe("POST /api/tool-calls/:id/permission — scope=forever admin gate", () => {
  test("non-admin posting scope='forever' is rejected 403", async () => {
    // Create a pending gate; we expect it to STILL be pending after
    // the rejected request (not resolved).
    createPermissionGate("tc-forever-non-admin", "conv-owner");
    expect(getPendingApproval("tc-forever-non-admin")).toBe(true);

    const res = await handleToolPermission(
      postPermission("tc-forever-non-admin", {
        approved: true,
        scope: "forever",
      }),
      "tc-forever-non-admin",
      MEMBER_OWNER,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/forever requires admin/i);

    // Defense-in-depth invariant: the gate MUST still be pending — the
    // 403 happens before resolvePermission is invoked.
    expect(getPendingApproval("tc-forever-non-admin")).toBe(true);
  });

  test("admin posting scope='forever' is accepted (gate resolves)", async () => {
    const gate = createPermissionGate("tc-forever-admin", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-forever-admin", {
        approved: true,
        scope: "forever",
      }),
      "tc-forever-admin",
      ADMIN_USER,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Gate MUST resolve without throwing.
    await gate;
  });

  test("non-admin posting scope='session' is accepted (sanity — not over-gated)", async () => {
    const gate = createPermissionGate("tc-session-member", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-session-member", {
        approved: true,
        scope: "session",
      }),
      "tc-session-member",
      MEMBER_OWNER,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("non-admin posting scope='project' is accepted (sanity — only forever is gated)", async () => {
    const gate = createPermissionGate("tc-project-member", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-project-member", {
        approved: true,
        scope: "project",
      }),
      "tc-project-member",
      MEMBER_OWNER,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("non-admin posting {approved: false, scope: 'forever'} (deny) is accepted — gate clears", async () => {
    // Cancel/deny is allowed even if scope='forever' tags along; the
    // gate is being cleared, not granting forever. (The handler only
    // gates approve-forever, not deny-with-irrelevant-scope.)
    const gate = createPermissionGate("tc-deny-forever", "conv-owner");
    const res = await handleToolPermission(
      postPermission("tc-deny-forever", {
        approved: false,
        scope: "forever",
      }),
      "tc-deny-forever",
      MEMBER_OWNER,
    );
    expect(res.status).toBe(200);
    await expect(gate).rejects.toThrow(/Permission denied/);
  });
});
