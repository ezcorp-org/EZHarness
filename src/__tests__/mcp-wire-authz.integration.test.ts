/**
 * B1 integration — cross-user MCP wiring, end to end.
 *
 * The bug: any authenticated member could attach ANY installed extension to
 * their own conversation, including an admin-installed MCP server carrying
 * the admin's credential. Two user-reachable paths had no check on the
 * extension ROW at all:
 *
 *   1. `POST /api/conversations/[id]/extensions` — ownership + an
 *      `extensions` API scope that is a NO-OP for a cookie session.
 *   2. `![ext:name]` / `![agent:name]` mention wiring.
 *
 * This file drives the REAL SvelteKit handler and the REAL mention-wiring
 * function against REAL PGlite: real extension rows, real conversations,
 * real `extension_rbac_grants` rows. The gate's own branch matrix is unit-
 * tested in `extension-wire-authz.test.ts`; what is proved HERE is that the
 * gate is actually reached from both surfaces and that a denial is shaped
 * like a miss.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import { sql } from "drizzle-orm";

mockDbConnection();

// ── $server / $lib aliases the conversation-extensions route imports ──
mock.module("$server/auth/middleware", () => require("../auth/middleware"));
mock.module("$server/auth/extension-wire-authz", () => require("../auth/extension-wire-authz"));
mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/db/queries/conversation-extensions", () => require("../db/queries/conversation-extensions"));
mock.module("$server/db/queries/conversations", () => require("../db/queries/conversations"));
mock.module("$lib/server/conversation-ownership", () =>
  require("../../web/src/lib/server/conversation-ownership"));
mock.module("$lib/server/security/api-keys", () => require("../../web/src/lib/server/security/api-keys"));
mock.module("$lib/server/security/validation", () => require("../../web/src/lib/server/security/validation"));
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));
mock.module("../../web/src/routes/api/conversations/[id]/extensions/$types", () => ({}));

import { POST as wirePOST } from "../../web/src/routes/api/conversations/[id]/extensions/+server";
import { wireMentionedExtensions } from "../runtime/mention-wiring";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { upsertGrant } from "../db/queries/extension-rbac";
import { conversations, extensions, messages, projects, users } from "../db/schema";
import type { AuthUser } from "../auth/types";

// ── Fixture ids ───────────────────────────────────────────────────────
const MCP_EXT = "wire-authz-mcp";
const PLAIN_EXT = "wire-authz-plain";
const MCP_EXT_GRANTED = "wire-authz-mcp-granted";

let projectId: string;
let admin: AuthUser;
let member: AuthUser;
let grantee: AuthUser;
let adminConvId: string;
let memberConvId: string;
let granteeConvId: string;
let extIds: Record<string, string> = {};

async function createUser(email: string, role: "admin" | "member"): Promise<AuthUser> {
  const rows = await getTestDb()
    .insert(users)
    .values({ email, passwordHash: "x", name: email, role })
    .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
  const r = rows[0]!;
  return { id: r.id, email: r.email, name: r.name, role: r.role };
}

async function createConversation(userId: string): Promise<string> {
  const rows = await getTestDb()
    .insert(conversations)
    .values({ title: `conv-${userId}`, userId, projectId })
    .returning({ id: conversations.id });
  return rows[0]!.id;
}

/** `conversation_extensions.added_by_message_id` is a real FK to `messages`,
 *  so the mention path needs a real row to attribute the wire to — a
 *  synthetic "msg-1" is rejected by the database. */
async function createMessage(conversationId: string): Promise<string> {
  const rows = await getTestDb()
    .insert(messages)
    .values({ conversationId, role: "user", content: "mention turn" })
    .returning({ id: messages.id });
  return rows[0]!.id;
}

/** Insert an extension row directly. `kind` drives `manifest.kind`, which is
 *  one of the two signals the gate reads. */
async function createExt(
  name: string,
  opts: { kind: "mcp" | "subprocess"; source: string; creatorUserId?: string | null },
): Promise<string> {
  const rows = await getTestDb()
    .insert(extensions)
    .values({
      name,
      version: "1.0.0",
      source: opts.source,
      creatorUserId: opts.creatorUserId ?? null,
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
        tools: [],
        permissions: {},
      })}::jsonb`,
    })
    .returning({ id: extensions.id });
  return rows[0]!.id;
}

/** Build the route event. `apiKeyScopes` is deliberately left UNSET, which
 *  is what a browser cookie session looks like — and the state in which
 *  `requireScope("extensions")` allows everything. */
function wireEvent(user: AuthUser, conversationId: string, names: string[]) {
  return createMockEvent({
    method: "POST",
    url: `http://localhost/api/conversations/${conversationId}/extensions`,
    user,
    params: { id: conversationId },
    body: { names },
  });
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  const projRows = await db
    .insert(projects)
    .values({ name: "Wire Authz Project", path: "/tmp/wire-authz" })
    .returning({ id: projects.id });
  projectId = projRows[0]!.id;

  admin = await createUser("wire-admin@test.local", "admin");
  member = await createUser("wire-member@test.local", "member");
  grantee = await createUser("wire-grantee@test.local", "member");

  adminConvId = await createConversation(admin.id);
  memberConvId = await createConversation(member.id);
  granteeConvId = await createConversation(grantee.id);

  extIds = {
    // Legacy shape: an MCP row with NO creator, exactly what every row
    // installed before the creator stamp looks like.
    [MCP_EXT]: await createExt(MCP_EXT, { kind: "mcp", source: "mcp:stdio" }),
    [PLAIN_EXT]: await createExt(PLAIN_EXT, { kind: "subprocess", source: "local" }),
    [MCP_EXT_GRANTED]: await createExt(MCP_EXT_GRANTED, { kind: "mcp", source: "mcp:http" }),
  };

  // The finer grant: `grantee` may WIRE one MCP extension, in one project.
  await upsertGrant({
    userId: grantee.id,
    projectId,
    extensionId: MCP_EXT_GRANTED, // the NAME — the column stores the slug
    scopes: ["mcp-wire"],
    grantedByUserId: admin.id,
  });
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("POST /api/conversations/[id]/extensions — the wire gate", () => {
  test("a member wiring an admin-installed MCP extension is refused, shaped as a MISS", async () => {
    const res = await wirePOST(wireEvent(member, memberConvId, [MCP_EXT]));
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    // Byte-identical to a name that does not exist — a member must not be
    // able to enumerate which MCP servers an admin has installed.
    expect(body).toEqual({ error: "Unknown extension(s)", unknown: [MCP_EXT] });
    expect(await getConversationExtensionIds(memberConvId)).toEqual([]);
  });

  test("the denial is INDISTINGUISHABLE from a genuinely unknown name", async () => {
    const denied = await jsonFromResponse(await wirePOST(wireEvent(member, memberConvId, [MCP_EXT])));
    const missing = await jsonFromResponse(
      await wirePOST(wireEvent(member, memberConvId, ["no-such-extension"])),
    );
    expect(denied.error).toBe(missing.error);
    expect(Object.keys(denied).sort()).toEqual(Object.keys(missing).sort());
  });

  test("a member wiring an ORDINARY extension still succeeds — no regression", async () => {
    const res = await wirePOST(wireEvent(member, memberConvId, [PLAIN_EXT]));
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.wired).toEqual([PLAIN_EXT]);
    expect(await getConversationExtensionIds(memberConvId)).toEqual([extIds[PLAIN_EXT]!]);
  });

  test("an admin wiring the same MCP extension succeeds", async () => {
    const res = await wirePOST(wireEvent(admin, adminConvId, [MCP_EXT]));
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.wired).toEqual([MCP_EXT]);
    expect(await getConversationExtensionIds(adminConvId)).toEqual([extIds[MCP_EXT]!]);
  });

  test("a member holding the `mcp-wire` grant may wire THAT MCP extension and no other", async () => {
    const ok = await wirePOST(wireEvent(grantee, granteeConvId, [MCP_EXT_GRANTED]));
    expect(ok.status).toBe(200);
    expect((await jsonFromResponse(ok)).wired).toEqual([MCP_EXT_GRANTED]);

    // The grant names one extension; the sibling MCP row is still refused.
    const nope = await wirePOST(wireEvent(grantee, granteeConvId, [MCP_EXT]));
    expect(nope.status).toBe(404);
    expect((await jsonFromResponse(nope)).unknown).toEqual([MCP_EXT]);
  });

  test("a mixed batch is ALL-OR-NOTHING — one denial wires nothing", async () => {
    const conv = await createConversation(member.id);
    const res = await wirePOST(wireEvent(member, conv, [PLAIN_EXT, MCP_EXT]));
    expect(res.status).toBe(404);
    expect((await jsonFromResponse(res)).unknown).toEqual([MCP_EXT]);
    // The allowed half must not have been written: a partial batch would
    // leave a half-wired conversation, which is the property the route's
    // pre-existing unknown-name check already guaranteed.
    expect(await getConversationExtensionIds(conv)).toEqual([]);
  });

  test("a member cannot wire into ANOTHER user's conversation (ownership still bites first)", async () => {
    const res = await wirePOST(wireEvent(member, adminConvId, [PLAIN_EXT]));
    expect(res.status).toBe(404);
    // Ownership 404s before the extension is ever resolved, so the body is
    // the ownership shape, not the unknown-names shape.
    expect((await jsonFromResponse(res)).error).toBe("Not found");
  });
});

describe("![ext:…] mention wiring — the same gate, silent", () => {
  test("a member's MCP mention wires nothing and raises nothing", async () => {
    const conv = await createConversation(member.id);
    const wired = await wireMentionedExtensions(
      conv,
      `please ![ext:${MCP_EXT}] check the weather`,
      await createMessage(conv),
      { userId: member.id, projectId },
    );
    // Silent no-op is the binding mention-grammar contract for an unknown
    // target; a denial must be indistinguishable from one.
    expect(wired).toEqual([]);
    expect(await getConversationExtensionIds(conv)).toEqual([]);
  });

  test("an admin's MCP mention wires it", async () => {
    const conv = await createConversation(admin.id);
    const wired = await wireMentionedExtensions(conv, `![ext:${MCP_EXT}] go`, await createMessage(conv), {
      userId: admin.id,
      projectId,
    });
    expect(wired).toEqual([extIds[MCP_EXT]!]);
  });

  test("a granted member's mention wires the granted extension only", async () => {
    const conv = await createConversation(grantee.id);
    const wired = await wireMentionedExtensions(
      conv,
      `![ext:${MCP_EXT_GRANTED}] and ![ext:${MCP_EXT}]`,
      await createMessage(conv),
      { userId: grantee.id, projectId },
    );
    expect(wired).toEqual([extIds[MCP_EXT_GRANTED]!]);
  });

  test("the grant is PROJECT-scoped — the same member in another project is refused", async () => {
    const otherProj = (await getTestDb()
      .insert(projects)
      .values({ name: "Other", path: "/tmp/wire-authz-other" })
      .returning({ id: projects.id }))[0]!.id;
    const conv = await createConversation(grantee.id);
    const wired = await wireMentionedExtensions(conv, `![ext:${MCP_EXT_GRANTED}] go`, await createMessage(conv), {
      userId: grantee.id,
      projectId: otherProj,
    });
    expect(wired).toEqual([]);
  });

  test("a mention with NO acting user wires the plain extension but not the MCP one", async () => {
    // A sub-conversation carries `userId: null`. It must inherit reach,
    // never acquire it.
    const conv = await createConversation(member.id);
    const wired = await wireMentionedExtensions(
      conv,
      `![ext:${PLAIN_EXT}] and ![ext:${MCP_EXT}]`,
      await createMessage(conv),
      { userId: null, projectId },
    );
    expect(wired).toEqual([extIds[PLAIN_EXT]!]);
  });

  test("an ![agent:…] config referencing an MCP extension is gated identically", async () => {
    // The bypass this closes: an agent config's `extensions` array is
    // user-authored, so gating only the direct `![ext:…]` mention would make
    // `![agent:mine]` a one-hop route to the same credential.
    const { createAgentConfig } = await import("../db/queries/agent-configs");
    await createAgentConfig({
      name: "wire-authz-agent",
      description: "d",
      prompt: "p",
      category: "agent",
      extensions: [extIds[MCP_EXT]!, extIds[PLAIN_EXT]!],
    } as never);

    const conv = await createConversation(member.id);
    const wired = await wireMentionedExtensions(conv, "![agent:wire-authz-agent] go", await createMessage(conv), {
      userId: member.id,
      projectId,
    });
    expect(wired).toEqual([extIds[PLAIN_EXT]!]);
  });
});
