// Regression test for sec-H3b: the same null-userId IDOR pattern covered
// by sec-H3 existed in 4 additional conversation sub-routes that share the
// pre-fix `if (conv.userId && conv.userId !== user.id)` short-circuit:
//
//   1. web/src/routes/api/conversations/[id]/tasks/[taskId]/assign/+server.ts
//      (POST + DELETE)
//   2. web/src/routes/api/conversations/[id]/tasks/[taskId]/messages/+server.ts
//      (GET)
//   3. web/src/routes/api/conversations/[id]/tasks/[taskId]/assignments/
//      [assignmentId]/start/+server.ts (POST)
//   4. web/src/routes/api/conversations/[id]/team/[agentConfigId]/messages/
//      +server.ts (GET)
//
// The fix (bytes in 6892e89 for #1–#3, and in ed8ac8a for #4) applies the
// same fail-closed rewrite:
//
//   - if (conv.userId && conv.userId !== user.id) …
//   + // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
//   + if (conv.userId !== user.id && user.role !== "admin") …
//
// Strategy (hybrid — same as sec-H3 test):
//   (A) Source-level regression gates on all 4 files. The fixed pattern
//       `user.role !== "admin"` is unambiguous and was not present pre-fix;
//       the pre-fix `conv.userId &&` short-circuit is absent post-fix.
//
//   (B) Behavioral probes on the two canonical GET handlers
//       (tasks/[taskId]/messages and team/[agentConfigId]/messages). These
//       are picked because they are the simplest of the four (no request
//       body, no bus/executor dependencies) and because together they
//       cover both fix commits:
//         - tasks/[taskId]/messages comes from 6892e89
//         - team/[agentConfigId]/messages comes from ed8ac8a
//       A non-admin "member" user requesting a null-owner conversation
//       must get 404 `{ error: "Not found" }` post-fix. Pre-fix bypasses
//       the ownership gate and continues downstream, producing a
//       structurally different 404 body ("Task not found" or "Team config
//       not found"), so the probes distinguish the two states cleanly.
//
// Tests fix(sec-H3b): 6892e89, ed8ac8a

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

mockServerAlias();

// $types stubs so SvelteKit's generated types don't trip the loader.
mock.module(
  "../../../web/src/routes/api/conversations/[id]/tasks/[taskId]/messages/$types",
  () => ({}),
);
mock.module(
  "../../../web/src/routes/api/conversations/[id]/team/[agentConfigId]/messages/$types",
  () => ({}),
);

// Stub web/src/lib/server/security/api-keys (scope check = noop allow).
const apiKeysMock = () => ({
  requireScope: () => null,
});
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module(
  "../../../web/src/lib/server/security/api-keys",
  apiKeysMock,
);

// Auth middleware: requireAuth returns whatever we put into locals.user.
// Mock BOTH the $server alias AND the resolved relative path per the
// dual-specifier lesson.
const authMiddlewareMock = () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      throw new Response("Unauthorized", { status: 401 });
    }
    return locals.user;
  },
});
mock.module("$server/auth/middleware", authMiddlewareMock);
mock.module("../../auth/middleware", authMiddlewareMock);

// ── In-memory conversation store ─────────────────────────────────

type Conversation = {
  id: string;
  userId: string | null;
  title: string;
  projectId: string | null;
};

let convStore: Map<string, Conversation>;

const convQueriesMock = () => ({
  getConversation: async (id: string) => convStore.get(id) ?? null,
  // Stubs for downstream handler logic (only exercised pre-fix, once the
  // ownership check is bypassed). Keep them inert; we just care which 404
  // branch we land in.
  getMessages: async () => [],
  getMessagesWithToolCalls: async () => ({ messages: [] }),
  getSubConversations: async () => [],
});
mock.module("$server/db/queries/conversations", convQueriesMock);
mock.module("../../db/queries/conversations", convQueriesMock);

// getAgentConfig is imported by team/[agentConfigId]/messages. Return null
// so the pre-fix path falls through to "Team config not found" — a 404
// with a different body than the fix's fail-closed "Not found".
const agentConfigsMock = () => ({
  getAgentConfig: async () => null,
});
mock.module("$server/db/queries/agent-configs", agentConfigsMock);
mock.module("../../db/queries/agent-configs", agentConfigsMock);

// task-tracking-host is imported inside the tasks/[taskId]/messages
// handler (Phase 3 commit-5 moved the in-memory store into a bundled
// extension's storage row). Mock the exports the handler reaches for.
// Store has no tasks matching any id, so the pre-fix path falls through
// to "Task not found".
const taskTrackingHostMock = () => ({
  getTaskSnapshotForConversation: async () => undefined,
  getTaskTrackingExtensionId: async () => "ext-test",
});
mock.module("$server/runtime/task-tracking-host", taskTrackingHostMock);
mock.module("../../runtime/task-tracking-host", taskTrackingHostMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────
import { GET as taskMessagesGet } from "../../../web/src/routes/api/conversations/[id]/tasks/[taskId]/messages/+server";
import { GET as teamMessagesGet } from "../../../web/src/routes/api/conversations/[id]/team/[agentConfigId]/messages/+server";

// SvelteKit handlers can throw a Response on auth failure; unwrap.
async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  convStore = new Map<string, Conversation>([
    // Conversation owned by user-a
    [
      "conv-owned-a",
      { id: "conv-owned-a", userId: "user-a", title: "A's conversation", projectId: null },
    ],
    // Conversation with null userId — the exploited branch
    [
      "conv-null-owner",
      { id: "conv-null-owner", userId: null, title: "Unowned (legacy) conversation", projectId: null },
    ],
  ]);
});

// ── (A) Source-level regression gates ─────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const H3B_FILES = [
  "web/src/routes/api/conversations/[id]/tasks/[taskId]/assign/+server.ts",
  "web/src/routes/api/conversations/[id]/tasks/[taskId]/messages/+server.ts",
  "web/src/routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start/+server.ts",
  "web/src/routes/api/conversations/[id]/team/[agentConfigId]/messages/+server.ts",
  // Added when ai-kit bundling made this endpoint reachable by OBO-
  // elevated system principals; same IDOR pattern had to be fixed here.
  "web/src/routes/api/conversations/[id]/sub-conversations/+server.ts",
];

describe("sec-H3b: all call sites have the fail-closed ownership check (source)", () => {
  for (const rel of H3B_FILES) {
    const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");

    test(`${rel} — contains the fail-closed admin escape hatch`, () => {
      // Post-fix every file gates unowned rows behind `user.role !== "admin"`.
      // Pre-fix none of them did.
      expect(src).toMatch(/user\.role\s*!==\s*"admin"/);
    });

    test(`${rel} — does NOT short-circuit on null conv.userId`, () => {
      // Pre-fix exploit: `conv.userId && conv.userId !== user.id`. The
      // leading truthiness guard lets null-owner rows pass the check.
      // Post-fix that exact shape is gone from every file.
      expect(src).not.toMatch(/conv\.userId\s*&&\s*conv\.userId\s*!==\s*user\.id/);
    });
  }
});

// ── (B) Behavioral probes on canonical handlers ───────────────────

describe("sec-H3b: GET /api/conversations/[id]/tasks/[taskId]/messages", () => {
  test("member on null-owner conversation → 404 fail-closed 'Not found'", async () => {
    // Post-fix: the fail-closed gate short-circuits before the dynamic
    // task-tracking import. Body is `{ error: "Not found" }`.
    //
    // Pre-fix: the ownership gate is bypassed (null userId), the handler
    // continues to the task-tracking store (mocked empty), and the task
    // lookup fails → body is `{ error: "Task not found" }`. Still a 404
    // but structurally different, and — critically — proves the unowned
    // row's existence was leaked to a non-admin in the pre-fix build.
    const res = await call(
      taskMessagesGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner/tasks/task-1/messages",
        params: { id: "conv-null-owner", taskId: "task-1" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Not found");
    expect(body.error).not.toBe("Task not found");
  });

  test("member on user-a's conversation → 404 (non-owner)", async () => {
    const res = await call(
      taskMessagesGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-owned-a/tasks/task-1/messages",
        params: { id: "conv-owned-a", taskId: "task-1" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Not found");
  });

  test("admin on null-owner conversation → proceeds past fail-closed", async () => {
    // Admin has the escape hatch, so the ownership check lets them through.
    // With no task in the mocked store, the handler returns the downstream
    // 404 `{ error: "Task not found" }`. This confirms the admin branch is
    // NOT hitting the fail-closed "Not found" body.
    const res = await call(
      taskMessagesGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner/tasks/task-1/messages",
        params: { id: "conv-null-owner", taskId: "task-1" },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Task not found");
  });
});

describe("sec-H3b: GET /api/conversations/[id]/team/[agentConfigId]/messages", () => {
  test("member on null-owner conversation → 404 fail-closed 'Not found'", async () => {
    // Post-fix: fail-closed gate short-circuits before any agent-config
    // lookup. Body is `{ error: "Not found" }`.
    //
    // Pre-fix: the gate is bypassed, handler calls `getAgentConfig()`
    // (mocked to return null), and returns 404 `{ error: "Team config
    // not found" }`. Distinct body proves the pre-fix leak.
    const res = await call(
      teamMessagesGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner/team/team-1/messages",
        params: { id: "conv-null-owner", agentConfigId: "team-1" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Not found");
    expect(body.error).not.toBe("Team config not found");
  });

  test("admin on null-owner conversation → proceeds past fail-closed", async () => {
    // Admin escape: reaches the downstream lookup which returns the
    // distinct 404 body. Confirms admins are NOT hitting fail-closed.
    const res = await call(
      teamMessagesGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner/team/team-1/messages",
        params: { id: "conv-null-owner", agentConfigId: "team-1" },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Team config not found");
  });
});
