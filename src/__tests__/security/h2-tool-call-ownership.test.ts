// Regression test for sec-H2: POST /api/tool-calls/[id]/permission must
// verify that the caller owns the conversation the pending permission
// gate belongs to before approving or denying it.
//
// Pre-fix the handler only validated the JSON body:
//
//   export async function handleToolPermission(req, toolCallId) {
//     const body = await req.json();
//     if (typeof body.approved !== "boolean") return 400;
//     resolvePermission(toolCallId, body.approved);  // ← no owner check
//     return 200;
//   }
//
// Any authenticated user who could observe or guess a pending toolCallId
// (UUID leak via websocket, timing, or scraped agent-run state) was able
// to approve or deny a shell-tool permission request for another user's
// conversation — including approving a pending `shell` execution for an
// admin, which is the exploit path the validation report called out.
//
// Fix (1d7b12b):
//   - permissions.ts: createPermissionGate now accepts a conversationId
//     second arg; the pending-approval map stores it alongside resolve/reject.
//   - executor.ts: passes conversationId when it creates the gate.
//   - tool-permission.ts: handleToolPermission now takes the authenticated
//     AuthUser, looks up the gate's conversation via getConversation, and
//     returns 403 unless `conv.userId === user.id || user.role === "admin"`.
//   - +server.ts: calls requireAuth(locals) before delegating, producing 401
//     when unauthenticated.
//
// Test matrix:
//   1. non-owner approves  → 403, gate still pending (not resolved)
//   2. non-owner denies    → 403, gate still pending (not rejected)
//   3. owner approves      → 200, gate resolves
//   4. admin approves      → 200 (instance-admin escape hatch, per sec-H3 pattern)
//   5. unauthenticated     → 401, gate still pending (requireAuth rejects first)
//   6. no pending gate     → 200 no-op (pre-fix shape preserved for page-refresh
//                            race tolerance; the endpoint must not become a
//                            gate-existence probe — the attack we care about is
//                            resolving an existing gate, which test 1/2 gate)
//   7. gate points at a deleted/missing conversation → 403 (fail-closed)
//
// Tests fix(sec-H2): 1d7b12b

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
} from "../helpers/mock-request";
import type { AuthUser } from "../../auth/types";

// ── Module-level mocks (BEFORE handler imports) ─────────────────────

mockServerAlias();

// $types stub so the SvelteKit-generated type module (not present at test time)
// is satisfied when the route file imports from "./$types".
mock.module("../../../web/src/routes/api/tool-calls/[id]/permission/$types", () => ({}));

// requireScope pass-through — we're exercising the new requireAuth +
// ownership check, not API-key scopes.
const apiKeysMock = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysMock);

// requireAuth — throws Response(401) when locals.user is missing, else passes.
// Dual-specifier per the Bun mock-cache lesson (handler imports via
// $server/*; tool-permission.ts would import via ../auth/middleware if it
// did, so we shadow both).
const authMiddlewareMock = () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  },
});
mock.module("$server/auth/middleware", authMiddlewareMock);
mock.module("../../auth/middleware", authMiddlewareMock);

// Conversation store — user-a owns conv-a; nothing else.
type Conv = {
  id: string;
  userId: string | null;
  projectId: string | null;
  title: string;
};
let convStore: Map<string, Conv>;
const convQueriesMock = () => ({
  getConversation: async (id: string) => convStore.get(id) ?? null,
});
// Dual specifier — tool-permission.ts imports via "../db/queries/conversations",
// and mockServerAlias() wires $server/db/queries/conversations to the real
// module; we override BOTH so the handler sees our store no matter which
// resolver path Bun uses first.
mock.module("$server/db/queries/conversations", convQueriesMock);
mock.module("../../db/queries/conversations", convQueriesMock);

// The +server.ts route does `await import("$server/routes/tool-permission")`.
// $server/* is a SvelteKit alias and needs an explicit mock in tests.
// Point it at the real module (which will pick up our mocked deps above).
mock.module("$server/routes/tool-permission", () =>
  require("../../routes/tool-permission"),
);

// ── Handler + gate helpers (AFTER mocks) ────────────────────────────
import { POST } from "../../../web/src/routes/api/tool-calls/[id]/permission/+server";
import {
  createPermissionGate,
  getPendingApproval,
  resolvePermission,
} from "../../runtime/tools/permissions";

// SvelteKit handlers sometimes throw Response on auth failure; unwrap.
async function call(handler: any, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

const USER_A: AuthUser = {
  id: "user-a",
  email: "a@test.local",
  name: "User A",
  role: "member",
};
const USER_B: AuthUser = {
  id: "user-b",
  email: "b@test.local",
  name: "User B",
  role: "member",
};

// Attach a noop catch to a gate promise so test failures along the 403
// path (gate stays pending and is cleaned up at end of test) don't crash
// the runner with unhandled rejections.
function silence(p: Promise<unknown>): void {
  p.catch(() => {});
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  convStore = new Map([
    [
      "conv-a",
      {
        id: "conv-a",
        userId: "user-a",
        projectId: null,
        title: "A's conversation",
      },
    ],
  ]);
});

describe("sec-H2: POST /api/tool-calls/:id/permission ownership check", () => {
  test("non-owner (user-b) approves user-a's pending gate → 403, gate NOT resolved", async () => {
    const gate = createPermissionGate("tc-h2-1", "conv-a");
    silence(gate);

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-1/permission",
        body: { approved: true },
        params: { id: "tc-h2-1" },
        user: USER_B,
      }),
    );

    expect(res.status).toBe(403);
    // Pre-fix this was 200 and the gate below would already be resolved.
    expect(getPendingApproval("tc-h2-1")).toBe(true);

    // Clean up: resolve the still-pending gate so it doesn't leak.
    resolvePermission("tc-h2-1", true);
    await gate;
  });

  test("non-owner (user-b) denies user-a's pending gate → 403, gate NOT rejected", async () => {
    const gate = createPermissionGate("tc-h2-2", "conv-a");
    silence(gate);

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-2/permission",
        body: { approved: false },
        params: { id: "tc-h2-2" },
        user: USER_B,
      }),
    );

    expect(res.status).toBe(403);
    // Pre-fix user-b's deny would have flipped the gate to a rejection,
    // which would have aborted user-a's tool call.
    expect(getPendingApproval("tc-h2-2")).toBe(true);

    resolvePermission("tc-h2-2", true);
    await gate;
  });

  test("owner (user-a) approves their own pending gate → 200, gate resolves", async () => {
    const gate = createPermissionGate("tc-h2-3", "conv-a");

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-3/permission",
        body: { approved: true },
        params: { id: "tc-h2-3" },
        user: USER_A,
      }),
    );

    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ ok: true });
    await expect(gate).resolves.toBeUndefined();
    expect(getPendingApproval("tc-h2-3")).toBe(false);
  });

  test("admin approves another user's pending gate → 200 (admin escape hatch)", async () => {
    const gate = createPermissionGate("tc-h2-4", "conv-a");

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-4/permission",
        body: { approved: true },
        params: { id: "tc-h2-4" },
        user: ADMIN_USER,
      }),
    );

    // Matches the sec-H3 fail-closed pattern: instance admins can act on
    // any conversation, including unowned legacy rows.
    expect(res.status).toBe(200);
    await expect(gate).resolves.toBeUndefined();
  });

  test("unauthenticated → 401, gate NOT resolved", async () => {
    const gate = createPermissionGate("tc-h2-5", "conv-a");
    silence(gate);

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-5/permission",
        body: { approved: true },
        params: { id: "tc-h2-5" },
        // no user — requireAuth throws Response(401)
      }),
    );

    expect(res.status).toBe(401);
    expect(getPendingApproval("tc-h2-5")).toBe(true);

    resolvePermission("tc-h2-5", true);
    await gate;
  });

  test("no pending gate → 200 no-op (page-refresh race tolerance)", async () => {
    // When no gate is registered for the id, the ownership check is not
    // exercised and the call remains a 200 no-op. This preserves the
    // pre-fix shape so a tab that POSTs after the user already resolved
    // the gate in another tab doesn't get a spurious 4xx. The attack
    // sec-H2 closes is resolving an EXISTING gate (tests 1/2).
    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-nonexistent/permission",
        body: { approved: true },
        params: { id: "tc-h2-nonexistent" },
        user: USER_B,
      }),
    );
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ ok: true });
  });

  test("pending gate whose conversation is missing → 403 (fail-closed)", async () => {
    // Edge case: a gate was created for a conversation id that no longer
    // resolves (row deleted mid-run, or mis-wired). Fail-closed — refuse
    // to act rather than silently allowing anyone to resolve it.
    const gate = createPermissionGate("tc-h2-6", "conv-missing");
    silence(gate);

    const res = await call(
      POST,
      createMockEvent({
        method: "POST",
        url: "http://localhost/api/tool-calls/tc-h2-6/permission",
        body: { approved: true },
        params: { id: "tc-h2-6" },
        user: USER_A,
      }),
    );

    expect(res.status).toBe(403);
    expect(getPendingApproval("tc-h2-6")).toBe(true);

    resolvePermission("tc-h2-6", true);
    await gate;
  });
});
