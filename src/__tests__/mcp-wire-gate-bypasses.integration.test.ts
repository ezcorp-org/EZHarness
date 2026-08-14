/**
 * Regression tests for the three ways an MCP extension's tools were
 * reachable WITHOUT passing the conversation-wiring gate. Each `test` below
 * is an adversarial reviewer's reproduction, committed.
 *
 * The wire gate (`src/auth/extension-wire-authz.ts`) originally guarded only
 * the two surfaces that write `conversation_extensions`. That was cosmetic,
 * because neither of the paths that actually DISPATCH a tool consults that
 * table:
 *
 *   F2  `POST /api/tool-invoke` resolved `<ext>__<tool>` from the GLOBAL
 *       registry map and called `executeToolCall` — no wiring, no
 *       conversation ownership. A member could spend an admin's MCP
 *       credential inside the ADMIN's own conversation.
 *   F3  `registry.getToolsForAgent` reads `agent_configs.extensions` (raw
 *       ids, author-supplied via a `chat`-scoped route) and handed the named
 *       extensions' tools straight to the LLM turn.
 *   F6  the gate asked for the `use` verb, which is NULL-covers-all in
 *       `extension_rbac_grants` — so ONE wildcard row authorized every MCP
 *       server on the instance.
 *
 * Everything here runs against real PGlite with real users, real extension
 * rows, a real registry and real grant rows. `ToolExecutor` is the one stub,
 * and deliberately so: the property under test is that dispatch is REFUSED
 * BEFORE reaching it, which a spy asserts far more precisely than inspecting
 * a tool's output would.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import { sql } from "drizzle-orm";

mockDbConnection();

// ── The one stub: the executor the route must never reach on a denial. ──
const executeToolCall = mock(async () => ({
  content: [{ type: "text" as const, text: "SPENT THE ADMIN CREDENTIAL" }],
  isError: false,
}));
const setCurrentUserId = mock((_id: string) => undefined);
mock.module("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    executeToolCall = executeToolCall;
    setCurrentUserId = setCurrentUserId;
  },
}));
mock.module("$server/extensions/permission-engine", () => ({
  getPermissionEngine: () => ({ __stub: "pdp" }),
}));
mock.module("$lib/server/context", () => ({
  ensureInitialized: async () => undefined,
  getBus: () => ({ emit: () => undefined, on: () => () => undefined }),
}));
// Spied, not just stubbed: this MUTATES `conversation_extensions` for the
// named conversation, so it must not run for a caller who fails ownership.
const ensureTaskTrackingWired = mock(async (_id: string) => undefined);
mock.module("$server/runtime/task-tracking-host", () => ({ ensureTaskTrackingWired }));

// ── Everything else is the real module behind its alias. ──
mock.module("$server/auth/middleware", () => require("../auth/middleware"));
mock.module("$server/auth/extension-wire-authz", () => require("../auth/extension-wire-authz"));
mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$lib/server/conversation-ownership", () =>
  require("../../web/src/lib/server/conversation-ownership"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("../../web/src/routes/api/tool-invoke/$types", () => ({}));

// DYNAMIC, and that is load-bearing: a static `import` is HOISTED above the
// `mock.module(...)` statements above it, so the handler would capture the
// REAL ToolExecutor and the stub would never apply. That failure mode is
// silent and looks like a passing security test — the first draft of this
// file hit it, and the tell was a real "MCP error -32000: Connection closed"
// coming back from a route that should never have dispatched.
const { POST: toolInvokePOST } = await import("../../web/src/routes/api/tool-invoke/+server");

import { ExtensionRegistry } from "../extensions/registry";
import { canWireExtension, loadWireActor } from "../auth/extension-wire-authz";
import { upsertGrant } from "../db/queries/extension-rbac";
import { createAgentConfig } from "../db/queries/agent-configs";
import { resolveConversationOwnerUserId, createSubConversation } from "../db/queries/conversations";
import { conversations, extensions, projects, users } from "../db/schema";
import type { AuthUser } from "../auth/types";

const MCP_NAME = "admins-mcp";
const PLAIN_NAME = "harmless-ext";

let projectId: string;
let admin: AuthUser;
let member: AuthUser;
let adminConvId: string;
let memberConvId: string;
let mcpExtId: string;
let plainExtId: string;

async function createUser(email: string, role: "admin" | "member"): Promise<AuthUser> {
  const rows = await getTestDb()
    .insert(users)
    .values({ email, passwordHash: "x", name: email, role })
    .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
  const r = rows[0]!;
  return { id: r.id, email: r.email, name: r.name, role: r.role };
}

async function createConversation(userId: string | null): Promise<string> {
  const rows = await getTestDb()
    .insert(conversations)
    .values({ title: "c", userId, projectId })
    .returning({ id: conversations.id });
  return rows[0]!.id;
}

/** A real extensions row whose manifest carries ONE tool, so the registry
 *  registers `<name>__<tool>` exactly as it would in production. */
async function createExt(
  name: string,
  opts: { kind: "mcp" | "subprocess"; source: string; tool: string },
): Promise<string> {
  const rows = await getTestDb()
    .insert(extensions)
    .values({
      name,
      version: "1.0.0",
      source: opts.source,
      enabled: true,
      manifest: sql`${JSON.stringify({
        schemaVersion: 2,
        name,
        version: "1.0.0",
        description: "",
        author: { name: "test" },
        kind: opts.kind,
        ...(opts.kind === "mcp"
          ? { mcpServers: [{ transport: "stdio", name, command: "true", env: { API_KEY: "" } }] }
          : { entrypoint: { command: ["true"] } }),
        tools: [{ name: opts.tool, description: "d", inputSchema: { type: "object" } }],
        permissions: {},
      })}::jsonb`,
    })
    .returning({ id: extensions.id });
  return rows[0]!.id;
}

function invokeEvent(user: AuthUser, conversationId: string, extensionName: string, toolName: string) {
  return createMockEvent({
    method: "POST",
    url: "http://localhost/api/tool-invoke",
    user,
    body: {
      extensionName,
      toolName,
      input: {},
      conversationId,
      invocationId: crypto.randomUUID(),
    },
  });
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  projectId = (await db
    .insert(projects)
    .values({ name: "Bypass Project", path: "/tmp/wire-bypass" })
    .returning({ id: projects.id }))[0]!.id;

  admin = await createUser("bypass-admin@test.local", "admin");
  member = await createUser("bypass-member@test.local", "member");
  adminConvId = await createConversation(admin.id);
  memberConvId = await createConversation(member.id);

  // The MCP row carries NO creator — the legacy shape, and the one the
  // reviewer used. Rung 3b therefore matches nobody.
  mcpExtId = await createExt(MCP_NAME, { kind: "mcp", source: "mcp:stdio", tool: "privileged" });
  plainExtId = await createExt(PLAIN_NAME, { kind: "subprocess", source: "local", tool: "safe" });

  ExtensionRegistry.resetInstance();
  await ExtensionRegistry.getInstance().loadFromDb();
}, 30_000);

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  executeToolCall.mockClear();
  setCurrentUserId.mockClear();
  ensureTaskTrackingWired.mockClear();
});

// ── F2 ───────────────────────────────────────────────────────────────
describe("F2 — POST /api/tool-invoke dispatched with no wiring and no ownership", () => {
  test("the precondition holds: the gate says this member may NOT wire this extension", async () => {
    // Pin the reviewer's setup assertion. Without this the tests below
    // could pass for the wrong reason (e.g. a fixture that was never MCP).
    const row = await getTestDb()
      .select()
      .from(extensions)
      .where(sql`${extensions.id} = ${mcpExtId}`);
    const actor = await loadWireActor(member.id, projectId);
    expect(await canWireExtension(row[0]!, actor)).toBe(false);
  });

  test("a member CANNOT dispatch an MCP tool into an ADMIN's conversation", async () => {
    const res = await toolInvokePOST(invokeEvent(member, adminConvId, MCP_NAME, "privileged"));
    expect(res.status).toBe(404);
    // Ownership is the first gate, so the body is the conversation shape.
    expect((await jsonFromResponse(res)).error).toBe("Conversation not found");
    // The whole point: the credential was never spent.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("ownership is checked BEFORE the task-tracking wire, which mutates", async () => {
    // `ensureTaskTrackingWired` writes `conversation_extensions` for the
    // named conversation. Running it before the ownership check would let
    // an unauthorized caller write into a conversation they cannot read.
    const res = await toolInvokePOST(
      invokeEvent(member, adminConvId, "task-tracking", "task_list"),
    );
    expect(res.status).toBe(404);
    expect(ensureTaskTrackingWired).not.toHaveBeenCalled();
  });

  test("a member CANNOT dispatch an MCP tool into their OWN conversation either", async () => {
    const res = await toolInvokePOST(invokeEvent(member, memberConvId, MCP_NAME, "privileged"));
    expect(res.status).toBe(404);
    // Same shape as an unregistered tool — a member must not learn that an
    // admin-installed MCP server by this name exists.
    expect((await jsonFromResponse(res)).error).toBe(`Tool not found: ${MCP_NAME}__privileged`);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("the denial is indistinguishable from a genuinely unregistered tool", async () => {
    const denied = await jsonFromResponse(
      await toolInvokePOST(invokeEvent(member, memberConvId, MCP_NAME, "privileged")),
    );
    const missing = await jsonFromResponse(
      await toolInvokePOST(invokeEvent(member, memberConvId, "no-such-ext", "nope")),
    );
    expect(Object.keys(denied).sort()).toEqual(Object.keys(missing).sort());
    expect(denied.success).toBe(missing.success);
  });

  test("an ADMIN can still dispatch the MCP tool in their own conversation", async () => {
    const res = await toolInvokePOST(invokeEvent(admin, adminConvId, MCP_NAME, "privileged"));
    expect(res.status).toBe(200);
    expect((await jsonFromResponse(res)).success).toBe(true);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  test("a member can still dispatch an ORDINARY extension's tool — no regression", async () => {
    const res = await toolInvokePOST(invokeEvent(member, memberConvId, PLAIN_NAME, "safe"));
    expect(res.status).toBe(200);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    // Unchanged behaviour: a non-MCP extension needs no wiring to dispatch,
    // which is what inline tool cards and Hub actions rely on.
  });
});

// ── F3 ───────────────────────────────────────────────────────────────
describe("F3 — an agent config attached MCP tools to the turn", () => {
  let agentConfigId: string;

  beforeAll(async () => {
    // Exactly the reviewer's chain: any member may POST this (scope `chat`),
    // naming raw extension ids they read off `GET /api/extensions`.
    const cfg = await createAgentConfig({
      name: "sneaky-agent",
      description: "d",
      prompt: "p",
      category: "agent",
      userId: member.id,
      extensions: [mcpExtId, plainExtId],
    } as never);
    agentConfigId = cfg.id;
  });

  test("without a gate the registry hands over the MCP tool (the bug, pinned)", async () => {
    // No `allowExtension` hook = the pre-fix call shape. Kept so the test
    // above it is provably testing the GATE and not a fixture that never
    // exposed the tool in the first place.
    const ungated = await ExtensionRegistry.getInstance().getToolsForAgent(agentConfigId);
    expect(ungated.map((t) => t.name).sort()).toEqual([
      `${MCP_NAME}__privileged`,
      `${PLAIN_NAME}__safe`,
    ]);
  });

  test("a member's turn gets the ordinary tool and NOT the MCP tool", async () => {
    const actor = await loadWireActor(member.id, projectId);
    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(agentConfigId, {
      allowExtension: async (extId) => {
        const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${extId}`);
        return rows[0] ? await canWireExtension(rows[0], actor) : false;
      },
    });
    expect(tools.map((t) => t.name)).toEqual([`${PLAIN_NAME}__safe`]);
  });

  test("an admin's turn gets both", async () => {
    const actor = await loadWireActor(admin.id, projectId);
    const tools = await ExtensionRegistry.getInstance().getToolsForAgent(agentConfigId, {
      allowExtension: async (extId) => {
        const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${extId}`);
        return rows[0] ? await canWireExtension(rows[0], actor) : false;
      },
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      `${MCP_NAME}__privileged`,
      `${PLAIN_NAME}__safe`,
    ]);
  });

  test("a throwing hook drops the extension rather than exposing it", async () => {
    const tools = await ExtensionRegistry.getInstance()
      .getToolsForAgent(agentConfigId, {
        allowExtension: async () => {
          throw new Error("grants store unreachable");
        },
      })
      .catch(() => [] as Array<{ name: string }>);
    // Whether the throw propagates (the 2b branch's try/catch turns it into
    // an empty tool set) or is swallowed, no tool may survive it.
    expect(tools).toEqual([]);
  });
});

// ── F6 ───────────────────────────────────────────────────────────────
describe("F6 — a wildcard grant must not authorize every MCP server", () => {
  test("a WILDCARD `use` grant does NOT authorize MCP wiring", async () => {
    // One row, NULL on both axes — `grantCovers` is NULL-covers-all, so
    // under the old `use` verb this single row authorized every MCP
    // extension on the instance, and every pre-existing `use` grant was
    // silently upgraded the day the gate shipped.
    await upsertGrant({
      userId: member.id,
      projectId: null,
      extensionId: null,
      scopes: ["use", "configure", "approve-runs"],
      grantedByUserId: admin.id,
    });
    const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${mcpExtId}`);
    const actor = await loadWireActor(member.id, projectId);
    expect(await canWireExtension(rows[0]!, actor)).toBe(false);
  });

  test("the dedicated `mcp-wire` verb DOES authorize it", async () => {
    await upsertGrant({
      userId: member.id,
      projectId: null,
      extensionId: MCP_NAME, // the NAME — the column stores the slug
      scopes: ["mcp-wire"],
      grantedByUserId: admin.id,
    });
    const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${mcpExtId}`);
    const actor = await loadWireActor(member.id, projectId);
    expect(await canWireExtension(rows[0]!, actor)).toBe(true);
  });

  test("and the granted member can now dispatch it through tool-invoke", async () => {
    // End-to-end: the escape hatch is real, not just a boolean.
    const res = await toolInvokePOST(invokeEvent(member, memberConvId, MCP_NAME, "privileged"));
    expect(res.status).toBe(200);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });
});

// ── Spawned-run ownership (settles the reviewer contradiction) ────────
describe("sub-conversation ownership is INHERITED, not null", () => {
  test("a sub-conversation created the way start-assignment creates one carries the ancestor owner", async () => {
    // `start-assignment.ts` resolves `resolveConversationOwnerUserId(parent)`
    // and stamps it. Reproduced here with the same two calls, because the
    // claim "sub-conversations persist userId: null" is TRUE only of
    // pre-Wave-0 rows and is no longer how any live path writes them.
    const ownerUserId = await resolveConversationOwnerUserId(adminConvId);
    expect(ownerUserId).toBe(admin.id);

    const sub = await createSubConversation(projectId, {
      parentConversationId: adminConvId,
      title: "child",
      ...(ownerUserId ? { userId: ownerUserId } : {}),
    });
    expect(sub.userId).toBe(admin.id);
  });

  test("so an admin's spawned child INHERITS reach — MCP wiring is allowed inside it", async () => {
    // The functional regression this rules out: if a child really carried
    // `userId: null`, an admin-owned parent spawning a sub-agent would find
    // its own MCP extension denied inside the child.
    const ownerUserId = await resolveConversationOwnerUserId(adminConvId);
    const sub = await createSubConversation(projectId, {
      parentConversationId: adminConvId,
      title: "child-2",
      ...(ownerUserId ? { userId: ownerUserId } : {}),
    });
    const actor = await loadWireActor(sub.userId, projectId);
    const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${mcpExtId}`);
    expect(await canWireExtension(rows[0]!, actor)).toBe(true);
  });

  test("a legacy NULL-owner chain still denies (fail-closed, and migrate() heals it)", async () => {
    const orphan = await createConversation(null);
    expect(await resolveConversationOwnerUserId(orphan)).toBeNull();
    const actor = await loadWireActor(null, projectId);
    const rows = await getTestDb().select().from(extensions).where(sql`${extensions.id} = ${mcpExtId}`);
    expect(await canWireExtension(rows[0]!, actor)).toBe(false);
  });
});
