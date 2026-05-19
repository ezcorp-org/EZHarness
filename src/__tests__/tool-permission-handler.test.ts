/**
 * Phase 56 (per-capability TTL UI) — Wave 0 RED scaffold for
 * `handleToolPermission`'s `ttlOverrideMs` plumbing.
 *
 * Today the chat-side handler at `src/routes/tool-permission.ts`
 * accepts `{ approved, scope? }`. Plan 56-02 widens the body schema
 * to ALSO accept an optional `ttlOverrideMs?: number | null` and
 * thread it through `resolvePermission` → the always-allow writer
 * (see `buildAlwaysAllowValue` in `src/extensions/permissions.ts`).
 *
 * These tests are RED until Plan 56-02 lands the field. The spy on
 * `resolvePermission` will record a fourth argument (`options`
 * carrying `ttlOverrideMs`); the test asserts the value, which fails
 * today because the handler discards the extra body field.
 *
 * Mocking style mirrors `src/__tests__/permission-engine.test.ts` —
 * `mock.module()` of dependent modules + `restoreModuleMocks()` in
 * `afterAll`. The Bun mock.module() cleanup rule from project
 * memory is followed: snapshot via preload, restore via
 * `restoreModuleMocks` to prevent loader-cache pollution across
 * subsequent test files.
 *
 * Cases:
 *   1. POST { approved: true, ttlOverrideMs: 7d }
 *      → resolvePermission called with options.ttlOverrideMs === 7d
 *   2. POST { approved: true, ttlOverrideMs: null }
 *      → resolvePermission called with options.ttlOverrideMs === null
 *      (the sticky-Never path — picker null-narrowing).
 *   3. POST { approved: true } (field omitted)
 *      → resolvePermission called with options.ttlOverrideMs ===
 *      undefined (legacy caller unaffected).
 *   4. POST { approved: true, ttlOverrideMs: 0 }
 *      → 400 (zero/negative rejected per RESEARCH Pitfall 2 —
 *      "ttlOverrideMs must be a positive number, null, or omitted").
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock collaborators ──────────────────────────────────────────────
//
// The handler at `src/routes/tool-permission.ts`:
//   • Calls `getPendingApprovalConversation(toolCallId)` from
//     `../runtime/tools/permissions`.
//   • Calls `getConversation(convId)` from `../db/queries/conversations`.
//   • Calls `resolvePermission(toolCallId, approved, scope?, options?)`
//     from `../runtime/tools/permissions`.
//
// `resolvePermission` is the spy point — Plan 56-02 widens its
// signature with an `options?: { ttlOverrideMs?: number | null }`
// fourth arg. We capture every call so the assertion can inspect
// the fourth positional argument.

const resolvePermissionCalls: Array<{
  toolCallId: string;
  approved: boolean;
  scope: unknown;
  options: unknown;
}> = [];
const getPendingApprovalConversationMock = mock(
  (_toolCallId: string): string | null => null,
);

mock.module("../runtime/tools/permissions", () => ({
  resolvePermission: (
    toolCallId: string,
    approved: boolean,
    scope?: unknown,
    options?: unknown,
  ) => {
    resolvePermissionCalls.push({ toolCallId, approved, scope, options });
  },
  getPendingApprovalConversation: (toolCallId: string) =>
    getPendingApprovalConversationMock(toolCallId),
}));

mock.module("../db/queries/conversations", () => ({
  getConversation: async (_id: string) => ({
    id: "conv-1",
    userId: "user-1",
  }),
}));

// `getSetting` / `upsertSetting` are unused by the POST handler today,
// but Plan 56-03 may add the sticky-pick write here. Stub them so
// neither path crashes if the handler taps the settings store.
mock.module("../db/queries/settings", () => ({
  getSetting: async (_key: string) => undefined,
  upsertSetting: async (_key: string, _value: unknown) => {},
}));

afterAll(() => restoreModuleMocks());

import { handleToolPermission } from "../routes/tool-permission";
import type { AuthUser } from "../auth/types";

const HELLO_TC = "tc-1";
const DAY_MS = 24 * 60 * 60 * 1000;

const user: AuthUser = {
  id: "user-1",
  email: "u@x",
  name: "u",
  role: "member",
};

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/tool-calls/${HELLO_TC}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resolvePermissionCalls.length = 0;
  getPendingApprovalConversationMock.mockClear();
});

describe("handleToolPermission — ttlOverrideMs plumbing", () => {
  test("body with ttlOverrideMs: 7d → resolvePermission called with options.ttlOverrideMs === 7d", async () => {
    const res = await handleToolPermission(
      makeRequest({
        approved: true,
        scope: "conversation",
        ttlOverrideMs: 7 * DAY_MS,
      }),
      HELLO_TC,
      user,
    );

    expect(res.status).toBe(200);
    expect(resolvePermissionCalls).toHaveLength(1);
    const call = resolvePermissionCalls[0]!;
    expect(call.toolCallId).toBe(HELLO_TC);
    expect(call.approved).toBe(true);
    expect(call.scope).toBe("conversation");
    // RED today: handler discards `ttlOverrideMs` so `options` is
    // `undefined`. Plan 56-02 makes it an object carrying the field.
    const options = call.options as { ttlOverrideMs?: number | null } | undefined;
    expect(options).toBeDefined();
    expect(options?.ttlOverrideMs).toBe(7 * DAY_MS);
  });

  test("body with ttlOverrideMs: null → resolvePermission called with options.ttlOverrideMs === null (sticky-Never path)", async () => {
    // CONTEXT.md locked decision: picker `Never` sets
    // `ttlOverrideMs: null` AND `expiresAt: null`. The null MUST
    // round-trip end-to-end through the handler so the always-allow
    // row writer can persist it.
    const res = await handleToolPermission(
      makeRequest({
        approved: true,
        scope: "conversation",
        ttlOverrideMs: null,
      }),
      HELLO_TC,
      user,
    );

    expect(res.status).toBe(200);
    expect(resolvePermissionCalls).toHaveLength(1);
    const options = resolvePermissionCalls[0]?.options as
      | { ttlOverrideMs?: number | null }
      | undefined;
    expect(options).toBeDefined();
    expect(options?.ttlOverrideMs).toBe(null);
  });

  test("body WITHOUT ttlOverrideMs → resolvePermission called with options.ttlOverrideMs === undefined (legacy caller unaffected)", async () => {
    // Legacy callers (pre-Phase-56 UI) post just `{approved, scope?}`.
    // The handler MUST keep working — the field is optional, and the
    // downstream always-allow writer falls back to TTL_CONFIG[kind]
    // when `ttlOverrideMs` is undefined.
    const res = await handleToolPermission(
      makeRequest({ approved: true, scope: "conversation" }),
      HELLO_TC,
      user,
    );

    expect(res.status).toBe(200);
    expect(resolvePermissionCalls).toHaveLength(1);
    const options = resolvePermissionCalls[0]?.options as
      | { ttlOverrideMs?: number | null }
      | undefined;
    // Post-fix shape: handler always passes an `options` object so the
    // resolver doesn't have to defend against arity drift. The field
    // inside is undefined when omitted by the caller.
    expect(options).toBeDefined();
    expect(options?.ttlOverrideMs).toBe(undefined);
  });

  test("body with ttlOverrideMs: 0 → 400 (zero/negative rejected; RESEARCH Pitfall 2)", async () => {
    // The handler MUST reject zero — a zero-ms TTL means "expires
    // immediately", which is a footgun that can revoke a grant the
    // very moment the user approves it. Negative values follow the
    // same rule. The accepted shape is positive number | null |
    // omitted.
    const res = await handleToolPermission(
      makeRequest({
        approved: true,
        scope: "conversation",
        ttlOverrideMs: 0,
      }),
      HELLO_TC,
      user,
    );

    expect(res.status).toBe(400);
    // resolvePermission must NOT be invoked on rejected requests.
    expect(resolvePermissionCalls).toHaveLength(0);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    // Pin the error message contract from Pitfall 2.
    expect(body.error).toMatch(/ttlOverrideMs/);
    expect(body.error).toMatch(/positive number.*null.*omitted/i);
  });

  test("body with ttlOverrideMs: -5 → 400 (negative rejected; same path as zero)", async () => {
    const res = await handleToolPermission(
      makeRequest({
        approved: true,
        scope: "conversation",
        ttlOverrideMs: -5,
      }),
      HELLO_TC,
      user,
    );

    expect(res.status).toBe(400);
    expect(resolvePermissionCalls).toHaveLength(0);
  });
});
