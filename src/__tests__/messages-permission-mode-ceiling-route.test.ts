/**
 * PR-1 — `POST /api/conversations/:id/messages` must not let a `chat`-scoped
 * key widen the project's tool-permission gate for a turn.
 *
 * `permissionMode` reaches `streamChat` from TWO independent intake paths:
 * the zod body schema (`messages/schema.ts`) and the multipart form parser
 * (`parseMultipart`, same route file). It then lands in the TOP-precedence
 * slot in `setup-tools.ts` — ahead of both the live bus override and the
 * project's stored mode. So `"yolo"` from a key auto-approved `shell`,
 * `edit_file` and `write` for the whole turn on a project whose owner had
 * deliberately chosen `ask`.
 *
 * Every arm below is run through BOTH intake paths, because a fix on one of
 * them is not a fix — and the two parsers share no code, so nothing but a
 * test keeps them in step.
 *
 * The one thing NOT changed: `DEFAULT_PERMISSION_MODE` is still `"yolo"`.
 * Flipping it is a breaking change for every existing install and belongs in
 * its own release. Consequence, asserted below: an unconfigured project has a
 * `yolo` ceiling and every override passes — which changes no behaviour,
 * because that is the mode the turn would have run at anyway.
 */

import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, ADMIN_USER } from "./helpers/mock-request";

mockServerAlias();

mock.module("$server/db/queries/attachments", () => require("../db/queries/attachments"));
mock.module("$server/db/queries/projects", () => require("../db/queries/projects"));
mock.module("$server/providers/model-capabilities", () => require("../providers/model-capabilities"));
mock.module("$server/chat/attachments/validator", () => require("../chat/attachments/validator"));
mock.module("$server/chat/attachments/storage", () => require("../chat/attachments/storage"));
mock.module("$server/chat/attachments/content-builder", () => require("../chat/attachments/content-builder"));

// `requireAuth` is the route's identity gate; the ceiling reads the auth
// METHOD off `locals` independently, so a single stubbed user is enough.
mock.module("$server/auth/middleware", () => ({
  ...require("../auth/middleware"),
  requireAuth: (_locals: unknown) => ADMIN_USER,
}));

const streamChatCalls: Array<Record<string, unknown>> = [];
mock.module("$lib/server/context", () => ({
  getExecutor: () => ({
    streamChat: async (..._args: unknown[]) => {
      streamChatCalls.push((_args[2] ?? {}) as Record<string, unknown>);
      return { id: "run-test", status: "success" };
    },
  }),
  getBus: () => ({ emit: () => {}, on: () => () => {} }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
  getGoalHost: () => null,
  ensureInitialized: async () => {},
}));
mock.module("$lib/server/security/validation", () => ({
  validationError: (err: { issues?: unknown }) =>
    new Response(JSON.stringify({ error: err.issues ?? String(err) }), { status: 400 }),
}));
mock.module("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: async () => ({ allowed: true, resetsAt: null }),
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mockDbConnection();

import * as convQueries from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { upsertSetting, deleteSetting } from "../db/queries/settings";

type PermissionMode = "ask" | "auto-edit" | "yolo";
type Intake = "json" | "multipart";

/** SvelteKit's generated `RequestHandler` type is not resolvable from the
 *  backend tree, so the dynamically-imported handler stays loosely typed —
 *  same shape the sibling route suites use. */
let POST: any;
let projectRoot: string;
let projectId: string;
let conversationId: string;

const SESSION_LOCALS = { authMethod: "session", user: { id: ADMIN_USER.id } };
const KEY_LOCALS = { authMethod: "api-key", user: { id: ADMIN_USER.id }, apiKeyId: "k1" };

const INTAKES: Intake[] = ["json", "multipart"];

function buildRequest(intake: Intake, mode: PermissionMode | undefined): Request {
  const url = `http://localhost/api/conversations/${conversationId}/messages`;
  if (intake === "multipart") {
    const form = new FormData();
    form.set("content", "hello");
    if (mode) form.set("permissionMode", mode);
    return new Request(url, { method: "POST", body: form });
  }
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode ? { content: "hello", permissionMode: mode } : { content: "hello" }),
  });
}

async function send(
  intake: Intake,
  mode: PermissionMode | undefined,
  locals: Record<string, unknown>,
): Promise<Response> {
  return POST({
    request: buildRequest(intake, mode),
    params: { id: conversationId },
    locals,
  });
}

async function setStoredMode(mode: PermissionMode | undefined): Promise<void> {
  const key = `project:${projectId}:tool_permission_mode`;
  if (mode === undefined) await deleteSetting(key);
  else await upsertSetting(key, mode);
}

beforeAll(async () => {
  await setupTestDb();
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-pmc-"));
  const project = await createProject({ name: "Ceiling Test", path: projectRoot });
  projectId = project.id;
  const mod = await import("../../web/src/routes/api/conversations/[id]/messages/+server");
  POST = mod.POST;
});

beforeEach(async () => {
  streamChatCalls.length = 0;
  const conv = await convQueries.createConversation(projectId, {
    title: "c",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  conversationId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

describe.each(INTAKES)("intake: %s", (intake) => {
  test("ARM 1 — a key requesting a WIDER mode is refused 403, naming the field", async () => {
    await setStoredMode("ask");
    const res = await send(intake, "yolo", KEY_LOCALS);

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.field).toBe("permissionMode");
    expect(body.requested).toBe("yolo");
    expect(body.ceiling).toBe("ask");
    expect(String(body.error)).toContain("permissionMode");

    // The turn must not have started at all.
    expect(streamChatCalls).toHaveLength(0);
    // …and it must leave no trace in the thread. Refusing after the user row
    // is persisted would show the sender a message that never ran.
    expect(await convQueries.getMessages(conversationId)).toHaveLength(0);
  });

  test("ARM 1b — the one-step widening (auto-edit over ask) is refused too", async () => {
    await setStoredMode("ask");
    const res = await send(intake, "auto-edit", KEY_LOCALS);
    expect(res.status).toBe(403);
    expect(streamChatCalls).toHaveLength(0);
  });

  test("ARM 2 — a key requesting an EQUAL mode is allowed and the mode reaches streamChat", async () => {
    await setStoredMode("auto-edit");
    const res = await send(intake, "auto-edit", KEY_LOCALS);
    expect(res.status).toBe(200);
    expect(streamChatCalls).toHaveLength(1);
    expect(streamChatCalls[0]?.permissionMode).toBe("auto-edit");
  });

  test("ARM 2b — a key requesting a NARROWER mode is allowed (volunteering to be asked needs no authority)", async () => {
    await setStoredMode("yolo");
    const res = await send(intake, "ask", KEY_LOCALS);
    expect(res.status).toBe(200);
    expect(streamChatCalls[0]?.permissionMode).toBe("ask");
  });

  test("ARM 3 — a cookie session may still set ANY mode, including the widest", async () => {
    await setStoredMode("ask");
    const res = await send(intake, "yolo", SESSION_LOCALS);
    expect(res.status).toBe(200);
    expect(streamChatCalls[0]?.permissionMode).toBe("yolo");
  });

  test("ARM 4 — no stored mode: the ceiling is the default, so a key's override passes and changes nothing", async () => {
    await setStoredMode(undefined);
    const res = await send(intake, "yolo", KEY_LOCALS);
    expect(res.status).toBe(200);
    expect(streamChatCalls[0]?.permissionMode).toBe("yolo");
  });

  test("a key sending NO permissionMode is unaffected even on a tightened project", async () => {
    await setStoredMode("ask");
    const res = await send(intake, undefined, KEY_LOCALS);
    expect(res.status).toBe(200);
    expect(streamChatCalls).toHaveLength(1);
    expect(streamChatCalls[0]?.permissionMode).toBe(undefined);
  });

  test("an UNSTAMPED principal is confined — the carve-out is an allowlist, not a denylist", async () => {
    await setStoredMode("ask");
    const res = await send(intake, "yolo", { user: { id: ADMIN_USER.id } });
    expect(res.status).toBe(403);
    expect(streamChatCalls).toHaveLength(0);
  });
});

describe("both intake paths are gated by the SAME check", () => {
  test("JSON and multipart give byte-identical refusals for the same request", async () => {
    await setStoredMode("ask");
    const jsonRes = await send("json", "yolo", KEY_LOCALS);
    const formRes = await send("multipart", "yolo", KEY_LOCALS);
    expect(jsonRes.status).toBe(formRes.status);
    expect(await jsonRes.json()).toEqual(await formRes.json());
  });
});
