/**
 * PR-11 — may a key answer the human's consent prompt?
 *
 * `POST /api/tool-calls/:id/permission` is `chat`-scoped and was gated on
 * conversation OWNERSHIP only. Ownership is not consent: a `chat` key issued
 * by the owner (or leaked from them) could approve a `shell` gate that the
 * owner's own BROWSER run had parked, waiting for a person to look at it. The
 * gate exists because a human decides; a key that can answer it mints the
 * consent instead of asking for it.
 *
 * Decision implemented here: an interactive session may answer anything it
 * owns (unchanged). Any other principal may answer ONLY a gate raised by a
 * run its own request started.
 *
 * The initiator is recorded on the gate at creation time from the ambient
 * scope `hooks.server.ts` opens around every authenticated request, so these
 * tests reproduce a run by creating the gate inside `runWithGateInitiator` —
 * the same call the request pipeline makes.
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

// Every gate below belongs to `conv-owner`, owned by `owner-user-1`. So the
// sec-H2 ownership check PASSES for all of them — which is exactly the point.
// Ownership is held constant so the only variable is the principal.
mock.module("../db/queries/conversations", () => ({
  getConversation: async (_id: string) => ({
    id: "conv-owner",
    userId: "owner-user-1",
    title: "Owner conversation",
    projectId: null,
  }),
}));

const { handleToolPermission } = await import("../routes/tool-permission");
const {
  createPermissionGate,
  createExtensionPermissionGate,
  getPendingApproval,
  getPendingApprovalInitiator,
  runWithGateInitiator,
  resolvePermission,
} = await import("../runtime/tools/permissions");

const OWNER: AuthUser = {
  id: "owner-user-1",
  email: "owner@test.local",
  name: "Owner",
  role: "member",
};
const ADMIN: AuthUser = {
  id: "admin-1",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

// The owner's browser tab.
const OWNER_SESSION = { authMethod: "session" as const, user: { id: OWNER.id } };
// Two DIFFERENT keys, both minted by the owner. `key-a` is the one that
// starts runs below; `key-b` stands in for a second (or leaked) key.
const KEY_A = { authMethod: "api-key" as const, user: { id: OWNER.id }, apiKeyId: "key-a" };
const KEY_B = { authMethod: "api-key" as const, user: { id: OWNER.id }, apiKeyId: "key-b" };

function postPermission(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/tool-calls/${id}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Raise a built-in gate the way a run started by `principal` would. */
function gateFrom(
  principal: { authMethod: "session" | "api-key" | "internal"; user?: { id: string }; apiKeyId?: string } | undefined,
  toolCallId: string,
): Promise<void> {
  const id = principal
    ? principal.authMethod === "session"
      ? `session:${principal.user?.id}`
      : `${principal.authMethod}:${principal.apiKeyId}`
    : undefined;
  const gate = runWithGateInitiator(id, () =>
    createPermissionGate(toolCallId, "conv-owner"),
  );
  // Denial rejects the gate; nothing here awaits a rejected promise, so
  // attach a sink so an intentionally-refused arm cannot surface as an
  // unhandled rejection.
  gate.catch(() => {});
  return gate;
}

beforeEach(() => {
  settingsStore = {};
});

describe("the initiator is recorded on the gate", () => {
  test("createPermissionGate stamps the ambient initiator", () => {
    runWithGateInitiator("api-key:key-a", () => createPermissionGate("tc-stamp", "conv-owner"));
    expect(getPendingApprovalInitiator("tc-stamp")).toBe("api-key:key-a");
    resolvePermission("tc-stamp", true);
  });

  test("it survives awaits — a run is a whole async subtree, not one call", async () => {
    // This is the property the whole design rests on: `streamChat` is
    // started and NOT awaited by the route, and the gate is opened many
    // awaits deep inside the executor loop. If the store did not propagate
    // through the promise chain, every gate would read as unattributed and
    // the fail-closed branch would refuse every key.
    await runWithGateInitiator("api-key:key-a", async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      createPermissionGate("tc-deep", "conv-owner");
    });
    expect(getPendingApprovalInitiator("tc-deep")).toBe("api-key:key-a");
    resolvePermission("tc-deep", true);
  });

  test("outside any scope the gate is unattributed", () => {
    createPermissionGate("tc-bare", "conv-owner").catch(() => {});
    expect(getPendingApprovalInitiator("tc-bare")).toBe(undefined);
    resolvePermission("tc-bare", true);
  });

  test("an undefined initiator does not shadow an enclosing scope", () => {
    runWithGateInitiator("session:owner-user-1", () =>
      runWithGateInitiator(undefined, () =>
        createPermissionGate("tc-nested", "conv-owner"),
      ),
    );
    expect(getPendingApprovalInitiator("tc-nested")).toBe("session:owner-user-1");
    resolvePermission("tc-nested", true);
  });

  test("extension gates are stamped by the same scope", async () => {
    const gate = runWithGateInitiator("api-key:key-a", () =>
      createExtensionPermissionGate({
        promptId: "pr-ext",
        conversationId: "conv-owner",
        userId: OWNER.id,
        extensionId: "ext-1",
        toolName: "t",
        capabilityKind: "shell",
      }),
    );
    expect(getPendingApprovalInitiator("pr-ext")).toBe("api-key:key-a");
    resolvePermission("pr-ext", false);
    expect((await gate).allowed).toBe(false);
  });
});

describe("POST /api/tool-calls/:id/permission — consent confinement", () => {
  test("ARM 1 — a key answering its OWN run's gate is allowed", async () => {
    const gate = gateFrom(KEY_A, "tc-own");
    const res = await handleToolPermission(
      postPermission("tc-own", { approved: true }),
      "tc-own",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("ARM 2 — a key answering the OWNER'S cookie-run gate is refused 403, gate stays pending", async () => {
    gateFrom(OWNER_SESSION, "tc-cookie-run");
    const res = await handleToolPermission(
      postPermission("tc-cookie-run", { approved: true }),
      "tc-cookie-run",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    // The refusal must happen BEFORE resolvePermission — a 403 that still
    // resolved the gate would be a 403 in name only.
    expect(getPendingApproval("tc-cookie-run")).toBe(true);
    resolvePermission("tc-cookie-run", false);
  });

  test("ARM 2b — a SECOND key of the same user is refused too", async () => {
    // The narrow case the `user.id` comparison could never catch: both keys
    // belong to the owner, and the owner owns the conversation, so ownership
    // says yes to both. Only the key identity separates them.
    gateFrom(KEY_A, "tc-sibling-key");
    const res = await handleToolPermission(
      postPermission("tc-sibling-key", { approved: true }),
      "tc-sibling-key",
      OWNER,
      KEY_B,
    );
    expect(res.status).toBe(403);
    expect(getPendingApproval("tc-sibling-key")).toBe(true);
    resolvePermission("tc-sibling-key", false);
  });

  test("ARM 3 — a cookie session is unchanged and may answer a gate its own run raised", async () => {
    const gate = gateFrom(OWNER_SESSION, "tc-session-own");
    const res = await handleToolPermission(
      postPermission("tc-session-own", { approved: true }),
      "tc-session-own",
      OWNER,
      OWNER_SESSION,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("ARM 3b — a cookie session may also answer a gate raised by a KEY-started run", async () => {
    // Deliberate asymmetry. The human is the answerer the gate is parked
    // for; confining THEM would strand a key-started run at the first
    // `ask`-mode shell call with nobody able to clear it.
    const gate = gateFrom(KEY_A, "tc-session-answers-key");
    const res = await handleToolPermission(
      postPermission("tc-session-answers-key", { approved: true }),
      "tc-session-answers-key",
      OWNER,
      OWNER_SESSION,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("ARM 4 — FAIL-SAFE: an unattributed gate is refused to a key", async () => {
    // Runs started outside the request pipeline — goal autopilot re-entry,
    // briefings, github-projects spawns, CLI — record no initiator. Chosen
    // side: CLOSED. It costs nothing that matters, because the next arm
    // shows the same gate is still answerable by the human it belongs to,
    // so fail-closed here can never strand a run.
    gateFrom(undefined, "tc-unattributed");
    const res = await handleToolPermission(
      postPermission("tc-unattributed", { approved: true }),
      "tc-unattributed",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(403);
    expect(getPendingApproval("tc-unattributed")).toBe(true);
    resolvePermission("tc-unattributed", false);
  });

  test("ARM 4b — and that same unattributed gate IS answerable by the owner's session", async () => {
    const gate = gateFrom(undefined, "tc-unattributed-session");
    const res = await handleToolPermission(
      postPermission("tc-unattributed-session", { approved: true }),
      "tc-unattributed-session",
      OWNER,
      OWNER_SESSION,
    );
    expect(res.status).toBe(200);
    await gate;
  });

  test("a key with NO key id cannot match an unattributed gate by both being undefined", async () => {
    // `principalId` returns undefined for a key that stamped no id, and an
    // unattributed gate's initiator is also undefined. `undefined ===
    // undefined` would have been an ALLOW; the explicit undefined check is
    // what stops it.
    gateFrom(undefined, "tc-both-undefined");
    const res = await handleToolPermission(
      postPermission("tc-both-undefined", { approved: true }),
      "tc-both-undefined",
      OWNER,
      { authMethod: "api-key", user: { id: OWNER.id } },
    );
    expect(res.status).toBe(403);
    resolvePermission("tc-both-undefined", false);
  });

  test("an INTERNAL principal is confined by the same rule", async () => {
    gateFrom(OWNER_SESSION, "tc-internal");
    const res = await handleToolPermission(
      postPermission("tc-internal", { approved: true }),
      "tc-internal",
      OWNER,
      { authMethod: "internal", user: { id: OWNER.id }, apiKeyId: "ik-1" },
    );
    expect(res.status).toBe(403);
    resolvePermission("tc-internal", false);
  });

  test("an ADMIN key is confined too — the role bypass covers ownership, not consent", async () => {
    // `user.role === "admin"` short-circuits the sec-H2 ownership check.
    // It must NOT also short-circuit this one: an admin-role KEY is still a
    // key, and the gate is still waiting for a person.
    gateFrom(OWNER_SESSION, "tc-admin-key");
    const res = await handleToolPermission(
      postPermission("tc-admin-key", { approved: true }),
      "tc-admin-key",
      ADMIN,
      { authMethod: "api-key", user: { id: ADMIN.id }, apiKeyId: "admin-key" },
    );
    expect(res.status).toBe(403);
    resolvePermission("tc-admin-key", false);
  });

  test("DENY is confined as well as approve", async () => {
    // A key that can DENY another principal's gate can cancel the human's
    // tool call at will — a smaller but real hole, so the check runs before
    // the approved/denied branch rather than inside it.
    gateFrom(OWNER_SESSION, "tc-deny-confined");
    const res = await handleToolPermission(
      postPermission("tc-deny-confined", { approved: false }),
      "tc-deny-confined",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(403);
    expect(getPendingApproval("tc-deny-confined")).toBe(true);
    resolvePermission("tc-deny-confined", false);
  });

  test("an unknown toolCallId stays a 200 no-op for a key (no gate, nothing to confine)", async () => {
    // Preserves the page-refresh-race shape documented on the handler. It
    // leaks nothing: the answer is identical whether or not a gate ever
    // existed under that id.
    const res = await handleToolPermission(
      postPermission("tc-nonexistent", { approved: true }),
      "tc-nonexistent",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("body validation still runs first — a malformed body from a key is 400, not 403", async () => {
    gateFrom(OWNER_SESSION, "tc-badbody");
    const res = await handleToolPermission(
      postPermission("tc-badbody", { approved: "yes" }),
      "tc-badbody",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(400);
    resolvePermission("tc-badbody", false);
  });

  test("a key may answer its own EXTENSION gate", async () => {
    const gate = runWithGateInitiator("api-key:key-a", () =>
      createExtensionPermissionGate({
        promptId: "pr-own",
        conversationId: "conv-owner",
        userId: OWNER.id,
        extensionId: "ext-1",
        toolName: "t",
        capabilityKind: "shell",
      }),
    );
    const res = await handleToolPermission(
      postPermission("pr-own", { approved: true, scope: "session" }),
      "pr-own",
      OWNER,
      KEY_A,
    );
    expect(res.status).toBe(200);
    expect((await gate).allowed).toBe(true);
  });
});
