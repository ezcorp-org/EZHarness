/**
 * The per-project tool permission mode — an authorization hole with two
 * exits, closed together because they share one request.
 *
 * `PUT /api/projects/[id]/tool-permission-mode` required `requireAuth` plus
 * `requireScope(locals, "chat")` and nothing else. Neither is a gate on WHOSE
 * project this is: `requireScope` is a documented NO-OP for cookie sessions,
 * and no ownership or membership check existed at all. `handleSetPermissionMode`
 * then wrote `project:<id>:tool_permission_mode` unconditionally, for any id
 * the caller typed.
 *
 * ── Exit 1: the project-wide mode is settable by a stranger ──
 *
 * `getPermissionMode(projectId)` (`src/runtime/tools/permissions.ts`) reads
 * that exact key, and `setup-tools.ts` consults it before every built-in tool
 * call in the project. So one PUT of `{"mode":"yolo"}` against a victim's
 * project id turned every later `write` and `execute` tool call in that
 * project from "ask the human" into "run it" — for every member of the
 * project, not just the caller. The same key is the ceiling a per-turn
 * override is checked against, so raising it also raises the ceiling.
 *
 * ── Exit 2: a cross-user gate kill, mid-turn ──
 *
 * The handler also emitted `tool:permission_mode_change` for ANY
 * `conversationId` in the body. Its subscriber
 * (`src/runtime/stream-chat/setup-tools.ts`) matches on conversation-id
 * equality alone and assigns `busOverrideMode`, which every later tool call in
 * that RUN reads in place of the stored mode. Knowing a victim's conversation
 * id was therefore enough to disable the permission gate on their in-flight
 * turn — no membership, no ownership, no wait for the next run.
 *
 * ── Exit 3: a key raises the ceiling on its own tool calls ──
 *
 * Closing the two above still left the WRITE reachable by any `chat`-scoped
 * API key belonging to a project member. That is the wrong principal for this
 * row. The stored mode is not a capability, it is STANDING CONSENT — it
 * pre-answers every future permission prompt in the project, for every member.
 * A key is precisely the non-interactive principal whose tool calls the prompt
 * exists to stop, so a key that may raise the mode is a key that may
 * auto-approve itself. `POST /api/workflows/approvals/:id` is session-only for
 * the strictly weaker act of spending ONE approval.
 *
 * ── What is under test ──
 *
 * Three halves are three different questions, gated in three places:
 *
 *   route   → `requireSessionAuth(locals)`                      — the METHOD
 *   route   → `checkProjectRole(locals, params.id, "member")`  — the PROJECT
 *   handler → the conversation is the caller's, and is IN this project
 *
 * All three shipped implementations run here. Only the DB reads underneath
 * them are stubbed (`getProjectMembership`, `getConversation`, the settings
 * KV), so `checkProjectRole`'s admin bypass, missing-row 403 and role ladder —
 * and `requireSessionAuth`'s fail-closed method allowlist — are the real ones
 * rather than a copy of the rule written in this file. Strategy
 * mirrors the sibling suite `cross-tenant-deletion-projects-kb-modes.test.ts`:
 * (A) source-level regression gates that flip with the fix, (B) behavioural
 * probes proving the attack is refused AND that the owner and an admin still
 * succeed.
 */

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

mockServerAlias();

mock.module("../../../web/src/routes/api/projects/[id]/tool-permission-mode/$types", () => ({}));

// Scope check = no-op allow. These probes are about the OWNERSHIP axis, so
// every caller below is modelled as a principal that HOLDS `read` + `chat` —
// which is exactly the attacker the hole handed the project to. The scope axis
// has its own suite.
const apiKeysMock = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysMock);

// The route imports the shared handler by SvelteKit alias at request time.
// Point it at the real module so the conversation gate under test is the
// shipped one.
mock.module("$server/routes/tool-permission", () => require("../../routes/tool-permission"));

// ── In-memory stores ─────────────────────────────────────────────

type Conv = { id: string; userId: string | null; projectId: string; title: string };

/** Membership rows, keyed `${projectId}:${userId}`. Stubbed at the QUERY
 *  layer, so the real `checkProjectRole` runs during every probe. */
let membershipStore: Map<string, { role: "owner" | "member" }>;
let convStore: Map<string, Conv>;
let settingsStore: Record<string, unknown>;
let emitted: Array<{ type: string; data: unknown }>;

const projectMembersMock = () => ({
  getProjectMembership: async (userId: string, projectId: string) => {
    const row = membershipStore.get(`${projectId}:${userId}`);
    return row ? { id: "pm-1", projectId, userId, role: row.role, createdAt: new Date() } : undefined;
  },
});
mock.module("$server/db/queries/project-members", projectMembersMock);
mock.module("../../db/queries/project-members", projectMembersMock);

const settingsMock = () => ({
  getSetting: async (key: string) => settingsStore[key],
  upsertSetting: async (key: string, value: unknown) => {
    settingsStore[key] = value;
  },
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

const conversationsMock = () => ({
  getConversation: async (id: string) => convStore.get(id) ?? null,
});
mock.module("$server/db/queries/conversations", conversationsMock);
mock.module("../../db/queries/conversations", conversationsMock);

// Both spellings, as with the api-keys mock above: bun resolves the `$lib`
// alias to the real file, so a mock keyed only on the alias string is not
// consulted and the route reaches the uninitialised singleton.
const contextMock = () => ({
  getBus: () => ({
    emit: (type: string, data: unknown) => {
      emitted.push({ type, data });
    },
  }),
});
mock.module("$lib/server/context", contextMock);
mock.module("../../../web/src/lib/server/context", contextMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────

import {
  GET as modeGet,
  PUT as modePut,
} from "../../../web/src/routes/api/projects/[id]/tool-permission-mode/+server";

const MODE_KEY = (projectId: string) => `project:${projectId}:tool_permission_mode`;

/** The victim: a plain instance member who owns `proj-victim` and `conv-victim`. */
const VICTIM = { id: "user-victim", email: "v@test.local", name: "Victim", role: "member" } as const;
/** The attacker: a plain instance member, a member of NO project. */
const ATTACKER = { id: "user-attacker", email: "x@test.local", name: "Attacker", role: "member" } as const;
/** A CO-MEMBER of the victim's project who does not own the victim's chat. */
const COMEMBER = { id: "user-comember", email: "c@test.local", name: "Co-member", role: "member" } as const;

async function call(handler: (ev: any) => unknown, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

/**
 * The "no `authMethod` was stamped at all" case, which is a DISTINCT input
 * from "the caller passed nothing" — a bare `undefined` argument would select
 * the `"session"` default below and silently test the opposite of what it
 * says. A sentinel makes the unstamped probe say so.
 */
const UNSTAMPED = Symbol("no authMethod stamped");

/**
 * `authMethod` defaults to `"session"` because the PUT is session-only: every
 * probe below that is ABOUT the project or conversation axis must clear the
 * session gate first, or it would pass for the wrong reason. The key probes
 * pass it explicitly.
 */
function putEvent(
  projectId: string,
  body: unknown,
  user: unknown,
  authMethod: string | typeof UNSTAMPED = "session",
) {
  return createMockEvent({
    method: "PUT",
    url: `http://localhost/api/projects/${projectId}/tool-permission-mode`,
    params: { id: projectId },
    body,
    user: user as any,
    authMethod: authMethod === UNSTAMPED ? undefined : authMethod,
  });
}

function getEvent(projectId: string, user: unknown, authMethod?: string) {
  return createMockEvent({
    url: `http://localhost/api/projects/${projectId}/tool-permission-mode`,
    params: { id: projectId },
    user: user as any,
    authMethod,
  });
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  // VICTIM owns proj-victim. COMEMBER is a plain member of it. ATTACKER and
  // ADMIN_USER hold NO row anywhere — so every admin success below proves the
  // role override, not a membership.
  membershipStore = new Map([
    ["proj-victim:user-victim", { role: "owner" as const }],
    ["proj-victim:user-comember", { role: "member" as const }],
    ["proj-attacker:user-attacker", { role: "owner" as const }],
  ]);
  convStore = new Map<string, Conv>([
    ["conv-victim", { id: "conv-victim", userId: VICTIM.id, projectId: "proj-victim", title: "Victim chat" }],
    ["conv-attacker", { id: "conv-attacker", userId: ATTACKER.id, projectId: "proj-attacker", title: "Attacker chat" }],
    ["conv-orphan", { id: "conv-orphan", userId: null, projectId: "proj-victim", title: "Deleted owner" }],
  ]);
  settingsStore = { [MODE_KEY("proj-victim")]: "ask" };
  emitted = [];
});

// ── (A) Source-level regression gates ─────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

describe("source: the mode route is membership-gated on BOTH verbs", () => {
  const REL = "web/src/routes/api/projects/[id]/tool-permission-mode/+server.ts";

  test(`${REL} — GET and PUT both call the shared project gate`, () => {
    const src = read(REL);
    // The regression signal is that the route DELEGATES to the shared ladder
    // rather than comparing anything itself — a route that re-derives the rule
    // is how the API and the ladder drift apart.
    const callSites = src.match(/checkProjectRole\(locals, params\.id, "member"\)/g) ?? [];
    expect(callSites.length).toBe(2);
    // …and the denial must be RETURNED, never thrown: SvelteKit surfaces a
    // thrown Response from a handler as a 500, which is how an intended 403
    // becomes an unintended 500.
    expect(src.match(/if \(gate instanceof Response\) return gate;/g) ?? []).toHaveLength(2);
    // Asserted over the HANDLERS only — the file's header comment quotes the
    // old shape while explaining why it is gone, and a whole-file assertion
    // would be satisfied by that prose.
    const handlers = src.slice(src.indexOf("export const GET"));
    expect(handlers.indexOf("export const GET")).toBe(0);
    expect(handlers).not.toMatch(/requireAuth\(locals\)/);
  });

  test(`${REL} — the WRITE is session-gated and the read is not`, () => {
    const src = read(REL);
    const handlers = src.slice(src.indexOf("export const GET"));
    const put = handlers.slice(handlers.indexOf("export const PUT"));
    const get = handlers.slice(0, handlers.indexOf("export const PUT"));
    // Exactly one call site, and it is in the PUT. A `requireSessionAuth` that
    // drifted into the GET would lock every agent out of reading the mode;
    // one that fell out of the PUT would re-open the key escalation.
    expect(put).toContain("requireSessionAuth(locals)");
    expect(get).not.toContain("requireSessionAuth");
    expect(handlers.match(/requireSessionAuth\(locals\)/g) ?? []).toHaveLength(1);
    // Returned, not thrown — same reason as the membership gate above.
    expect(put).toContain("if (session instanceof Response) return session;");
    // And it runs BEFORE the membership lookup, so a key is refused as "not a
    // session" rather than being told whether it belongs to this project.
    expect(put.indexOf("requireSessionAuth(locals)")).toBeLessThan(
      put.indexOf("checkProjectRole(locals, params.id, \"member\")"),
    );
  });

  test("src/routes/tool-permission.ts — the emit is conversation-gated", () => {
    const src = read("src/routes/tool-permission.ts");
    const handler = src.slice(src.indexOf("export async function handleSetPermissionMode"));
    expect(handler.indexOf("export async function handleSetPermissionMode")).toBe(0);
    // The gate reads the conversation and compares BOTH coordinates. Without
    // the project comparison the event crosses projects; without the owner
    // comparison it crosses users.
    expect(handler).toContain("await getConversation(conversationId)");
    expect(handler).toMatch(/conv\.projectId !== projectId/);
    expect(handler).toMatch(/conv\.userId !== user\.id && user\.role !== "admin"/);
    // The refusal must precede the write, so a denial leaves nothing behind.
    expect(handler.indexOf('return json({ error: "Forbidden" }, 403)')).toBeLessThan(
      handler.indexOf("await upsertSetting("),
    );
  });
});

// ── (B) Behavioural probes ────────────────────────────────────────

describe("ATTACK 1: PUT — a stranger raises another project's permission mode", () => {
  test("a non-member cannot set the victim project's mode", async () => {
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "yolo" }, ATTACKER));
    expect(res.status).toBe(403);
    // The load-bearing assertion: the stored mode is untouched, so the
    // victim's next `shell` call still stops for a human.
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("a member of a DIFFERENT project is still refused", async () => {
    // Discrimination for the cell above: the gate is not "holds any membership
    // row at all" — the attacker owns proj-attacker and is still refused.
    expect(membershipStore.has(`proj-attacker:${ATTACKER.id}`)).toBe(true);
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "yolo" }, ATTACKER));
    expect(res.status).toBe(403);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("the project's own member CAN set it", async () => {
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "auto-edit" }, VICTIM));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ ok: true });
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("auto-edit");
  });

  test("an instance ADMIN can still set it without a membership row", async () => {
    expect(membershipStore.has(`proj-victim:${ADMIN_USER.id}`)).toBe(false);
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "yolo" }, ADMIN_USER));
    expect(res.status).toBe(200);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("yolo");
  });

  test("an unauthenticated caller gets 401 and writes nothing", async () => {
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "yolo" }, undefined));
    expect(res.status).toBe(401);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("an UNKNOWN project id is refused for a non-admin — no key is written", async () => {
    // Fail-closed on the ownerless case: a project with no membership rows
    // (unknown, or orphaned) matches nobody, so only the admin override
    // reaches it. Nothing lands in the settings KV for a stranger's typo.
    const res = await call(modePut as any, putEvent("proj-nonexistent", { mode: "yolo" }, ATTACKER));
    expect(res.status).toBe(403);
    expect(settingsStore[MODE_KEY("proj-nonexistent")]).toBeUndefined();
  });
});

describe("ATTACK 2: PUT — the bus emit kills the gate on another user's live run", () => {
  test("a CO-MEMBER cannot push a mode change into a chat they do not own", async () => {
    // The sharp case, and the reason the conversation check is a SECOND gate
    // rather than a re-statement of the first: this caller passes the project
    // gate honestly. `setup-tools.ts` matches the event on conversation id
    // alone, so without this check a co-worker could switch a running turn to
    // `yolo` between two of its tool calls.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-victim" }, COMEMBER),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
    // And the request is refused WHOLE — no half-honoured project write.
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("a non-member naming the victim's conversation is refused before the lookup", async () => {
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-victim" }, ATTACKER),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("a conversation in ANOTHER project is refused even for that chat's owner", async () => {
    // The attacker owns conv-attacker, but it lives in proj-attacker. Without
    // the project comparison this project's mode would be pushed into a run
    // that is not in this project.
    membershipStore.set(`proj-victim:${ATTACKER.id}`, { role: "member" });
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-attacker" }, ATTACKER),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
  });

  test("an ORPHANED conversation (owner deleted) matches nobody", async () => {
    // `conversations.user_id` is SET NULL when the owner is deleted. A null
    // owner must not read as "anyone may act" — the sec-H3 rule.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-orphan" }, COMEMBER),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
  });

  test("an UNKNOWN conversation id is refused, not silently ignored", async () => {
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-nope" }, VICTIM),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("a non-string conversationId is a 400", async () => {
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: 42 }, VICTIM),
    );
    expect(res.status).toBe(400);
    expect((await jsonFromResponse(res)).error).toContain("conversationId");
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("the conversation's OWNER still gets the live switch", async () => {
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-victim" }, VICTIM),
    );
    expect(res.status).toBe(200);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("yolo");
    expect(emitted).toEqual([
      { type: "tool:permission_mode_change", data: { conversationId: "conv-victim", mode: "yolo" } },
    ]);
  });

  test("an ADMIN may switch another user's run — the documented override", async () => {
    // Recorded as a decision rather than left implicit: instance admins bypass
    // the ownership half here exactly as they do on the built-in gate resolver
    // (`handleToolPermission`'s sec-H2 check). The PROJECT half still binds
    // them — a conversation from another project is refused above.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-victim" }, ADMIN_USER),
    );
    expect(res.status).toBe(200);
    expect(emitted).toHaveLength(1);
  });

  test("a project-wide change with no conversationId emits nothing", async () => {
    const res = await call(modePut as any, putEvent("proj-victim", { mode: "yolo" }, VICTIM));
    expect(res.status).toBe(200);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("yolo");
    expect(emitted).toEqual([]);
  });

  test("an invalid mode is rejected before any conversation lookup", async () => {
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "nope", conversationId: "conv-victim" }, VICTIM),
    );
    expect(res.status).toBe(400);
    expect(emitted).toEqual([]);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });
});

describe("ATTACK 3: PUT — a non-interactive principal raises its OWN ceiling", () => {
  // The project gate above answers WHOSE project this is. It does not answer
  // whether this principal may decide the project's standing posture at all,
  // and for a key the answer is no: the same `chat` key that runs the agent
  // would be raising the ceiling on that agent's own `shell` calls, so the
  // permission gate would be asking the caller's permission to gate the
  // caller. `requireSessionAuth` is the same gate `POST /api/workflows/
  // approvals/:id` uses to keep a leaked key from spending ONE approval; this
  // row pre-answers all of them.
  //
  // Every probe here uses VICTIM — the project's OWNER — so the refusal can
  // only be about the auth METHOD. A non-member would be refused anyway.
  test("a `chat`-scoped API key cannot set the mode, even as the project owner", async () => {
    expect(membershipStore.get(`proj-victim:${VICTIM.id}`)!.role).toBe("owner");
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo" }, VICTIM, "api-key"),
    );
    expect(res.status).toBe(403);
    expect((await jsonFromResponse(res)).error).toBe("Interactive session required");
    // The load-bearing assertion: the ceiling did not move.
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("an ADMIN's key is refused too — the role does not buy the method", async () => {
    // `checkProjectRole` lets an admin bypass MEMBERSHIP. It has nothing to
    // say about being a session, and the two must not be confused: an
    // admin-minted key is exactly the credential worth stealing.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo" }, ADMIN_USER, "api-key"),
    );
    expect(res.status).toBe(403);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("the `internal` extension-host principal is refused — the sharpest case", async () => {
    // `bearer-auth.ts` stamps `internal` for the loopback extension host. An
    // extension calling back into the API must not be able to stop the host
    // asking about its own `shell` calls.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo" }, VICTIM, "internal"),
    );
    expect(res.status).toBe(403);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("an UNSTAMPED principal is refused — the allowlist fails closed", async () => {
    // `authMethod` is stamped positively by each auth site. A future auth mode
    // that populates `locals.user` and forgets to stamp must land on DENY, not
    // on allow-by-omission.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo" }, VICTIM, UNSTAMPED),
    );
    expect(res.status).toBe(403);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("ask");
  });

  test("the key cannot reach the conversation half either", async () => {
    // Refused before the emit, so a key cannot switch even its OWN live run —
    // which is the whole point: the run is where the escalation would be spent.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo", conversationId: "conv-victim" }, VICTIM, "api-key"),
    );
    expect(res.status).toBe(403);
    expect(emitted).toEqual([]);
  });

  test("the same request from a real session succeeds — the gate is the method", async () => {
    // Discrimination: identical project, principal, body and mode. Only
    // `authMethod` differs from the first cell, so the 403s above cannot be
    // some unrelated refusal.
    const res = await call(
      modePut as any,
      putEvent("proj-victim", { mode: "yolo" }, VICTIM, "session"),
    );
    expect(res.status).toBe(200);
    expect(settingsStore[MODE_KEY("proj-victim")]).toBe("yolo");
  });

  test("READING the mode with a key still works — only the write is narrowed", async () => {
    // An agent must be able to see the posture it is running under. Gating the
    // read would break that for no security gain: disclosure to a project
    // MEMBER escalates nothing, and the write is where consent is spent.
    const res = await call(modeGet as any, getEvent("proj-victim", VICTIM, "api-key"));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ mode: "ask" });
  });
});

describe("GET — the stored mode is not readable by a stranger", () => {
  test("a non-member cannot read the victim project's mode", async () => {
    const res = await call(modeGet as any, getEvent("proj-victim", ATTACKER));
    expect(res.status).toBe(403);
    // Nothing about the project's posture may appear in the denial body.
    expect(await res.text()).not.toContain("ask");
  });

  test("the project's own member CAN read it", async () => {
    const res = await call(modeGet as any, getEvent("proj-victim", VICTIM));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ mode: "ask" });
  });

  test("an instance ADMIN can read it without a membership row", async () => {
    const res = await call(modeGet as any, getEvent("proj-victim", ADMIN_USER));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ mode: "ask" });
  });

  test("a member of an unconfigured project reads the default", async () => {
    // `DEFAULT_PERMISSION_MODE` is `yolo` and that is a locked product
    // decision — pinned here so the gate above cannot be mistaken for a change
    // to the default.
    const res = await call(modeGet as any, getEvent("proj-attacker", ATTACKER));
    expect(res.status).toBe(200);
    expect(await jsonFromResponse(res)).toEqual({ mode: "yolo" });
  });
});
