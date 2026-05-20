/**
 * Cross-tier integration test for slash-command expansion.
 *
 * Pipeline under test:
 *   POST /api/conversations/[id]/messages
 *     → buildCommandResolver(userId, projectId)
 *       → CommandRegistry.findCommand
 *     → executor.streamChat({ ..., commandResolver })
 *       → buildPromptInput → applyCommandExpansion
 *
 * What we exercise:
 *   - The route persists the RAW `/[cmd:name]` token (per
 *     docs/slash-commands.md "Persisted conversation history stores the
 *     raw `/[cmd:name]` token").
 *   - The text the LLM eventually sees has the body substituted in.
 *   - $ARGUMENTS / $1 substitution is wired through.
 *   - Unknown commands fall through to a system-note pre-amble (no
 *     thrown error) — token is left literal.
 *   - SECURITY: a body containing `![ext:evil]` / `@[file:/etc/passwd]`
 *     is treated as plain text downstream — expansion is literal, never
 *     re-parsed for other mention kinds (CLAUDE.md, mention-wiring.ts).
 *   - Multiple commands in one message expand independently.
 *
 * Strategy:
 *   - Real PGlite — messages persistence is tested honestly.
 *   - Real route handler (`+server.ts` POST).
 *   - Stub `getExecutor()` so the LLM call never happens; the stub
 *     pulls `commandResolver` out of the options bundle and itself
 *     drives `applyCommandExpansion(userMessage, commandResolver)` so
 *     the full route → resolver → expansion path is exercised. This
 *     mirrors what `buildPromptInput` would do inside the real
 *     executor; we capture the resulting text.
 *   - Stub `getCommandRegistry()` with a small in-memory map keyed on
 *     command name → body/frontmatter — `buildCommandResolver` calls
 *     `findCommand` on whatever registry it is handed.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, ADMIN_USER } from "./helpers/mock-request";

// ── Server-side aliases used by +server.ts ──────────────────────────
mockServerAlias();

// Aliases the route uses that mockServerAlias() doesn't cover.
mock.module("$server/db/queries/attachments", () => require("../db/queries/attachments"));
mock.module("$server/db/queries/projects", () => require("../db/queries/projects"));
mock.module("$server/providers/model-capabilities", () => require("../providers/model-capabilities"));
mock.module("$server/chat/attachments/validator", () => require("../chat/attachments/validator"));
mock.module("$server/chat/attachments/storage", () => require("../chat/attachments/storage"));
mock.module("$server/chat/attachments/content-builder", () => require("../chat/attachments/content-builder"));

// Auth middleware lives under web/ — stub it to a fixed admin user so
// ownership check passes regardless of conv.userId.
mock.module("$server/auth/middleware", () => ({
  requireAuth: (_locals: any) => ADMIN_USER,
}));

// Security middleware — pass-through no-ops.
mock.module("$lib/server/security/validation", () => ({
  validationError: (err: any) =>
    new Response(JSON.stringify({ error: err.issues ?? String(err) }), { status: 400 }),
}));
mock.module("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: async () => ({ allowed: true, resetsAt: null }),
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Command registry stub ───────────────────────────────────────────
// Maps command name → { body, frontmatter }. Per-test mutation lets
// each test customise the resolver without remocking.
const commandTable = new Map<string, { body: string; frontmatter?: Record<string, string> }>();

function setCommand(name: string, body: string, frontmatter?: Record<string, string>) {
  commandTable.set(name, { body, frontmatter });
}

function clearCommands() {
  commandTable.clear();
}

const fakeRegistry = {
  async findCommand(opts: { name: string }) {
    const found = commandTable.get(opts.name);
    if (!found) return null;
    return {
      name: opts.name,
      body: found.body,
      frontmatter: found.frontmatter ?? {},
      // Filler fields buildCommandResolver doesn't read.
      namespace: "user:db",
      description: "",
      source: "user:db",
      path: "",
    };
  },
  async listCommands() {
    return [...commandTable.entries()].map(([name, v]) => ({
      name,
      body: v.body,
      frontmatter: v.frontmatter ?? {},
      namespace: "user:db",
      description: "",
      source: "user:db",
      path: "",
    }));
  },
  invalidate() {},
};

// ── Executor stub: capture options + run real expansion ─────────────
// We invoke the real `applyCommandExpansion` here so the test exercises
// the real expansion code (which is what buildPromptInput would call),
// without firing up an LLM-bound Agent.
type StreamChatCall = {
  conversationId: string;
  userMessage: string;
  options: { commandResolver?: any; projectId?: string; [k: string]: any };
  llmVisiblePrompt: string;
};
const streamChatCalls: StreamChatCall[] = [];
// Tracks the in-flight streamChat promises so tests can await
// completion. The route fires streamChat fire-and-forget, so without
// this gate `streamChatCalls` may not yet contain the captured entry
// when the test code reads it.
const inflightStreamChats: Promise<unknown>[] = [];

mock.module("$lib/server/context", () => ({
  getExecutor: () => ({
    streamChat: (
      conversationId: string,
      userMessage: string,
      options: { commandResolver?: any; [k: string]: any },
    ) => {
      const p = (async () => {
        // Pull in the REAL applyCommandExpansion so we test the actual
        // expansion code path, not a re-implementation. Dynamic require
        // because mock-cleanup snapshots this module.
        const { applyCommandExpansion } = require("../runtime/mention-wiring");
        let llmVisiblePrompt = userMessage;
        if (options.commandResolver) {
          llmVisiblePrompt = await applyCommandExpansion(userMessage, options.commandResolver);
        }
        streamChatCalls.push({ conversationId, userMessage, options, llmVisiblePrompt });
        return { id: "run-test", status: "success" } as any;
      })();
      inflightStreamChats.push(p);
      return p;
    },
  }),
  getBus: () => ({ emit: () => {}, on: () => () => {} }),
  // buildCommandResolver calls getCommandRegistry() — return our fake.
  getCommandRegistry: () => fakeRegistry,
  getGoalHost: () => null,
  ensureInitialized: async () => {},
}));

// Gate helper: drain all in-flight streamChat promises.
async function flushStreamChat() {
  while (inflightStreamChats.length > 0) {
    const pending = inflightStreamChats.splice(0);
    await Promise.allSettled(pending);
  }
}

// ── Real DB ─────────────────────────────────────────────────────────
mockDbConnection();

mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting() {},
    async deleteSetting() { return false; },
    async isListingInstalled() { return false; },
  };
});

// Imports AFTER all mocks (dynamic for the route to ensure mocks bind).
let POST: any;
import * as convQueries from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let projectRoot: string;
let projectId: string;
let conversationId: string;

beforeAll(async () => {
  await setupTestDb();
  projectRoot = await mkdtemp(join(tmpdir(), "ezcorp-cmd-exp-"));
  const project = await createProject({ name: "CmdExp", path: projectRoot });
  projectId = project.id;
  const mod = await import("../../web/src/routes/api/conversations/[id]/messages/+server");
  POST = mod.POST;
});

beforeEach(async () => {
  streamChatCalls.length = 0;
  inflightStreamChats.length = 0;
  clearCommands();
  const conv = await convQueries.createConversation(projectId, {
    title: "cmd",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
  });
  conversationId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

function postJson(content: string): Promise<Response> {
  const req = new Request(
    `http://localhost/api/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  return POST({
    request: req,
    params: { id: conversationId },
    locals: {} as any,
  } as any);
}

async function expectOk(res: Response): Promise<any> {
  if (res.status !== 200) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  }
  return res.json();
}

// ── Tests ───────────────────────────────────────────────────────────

describe("slash-command expansion: route → resolver → executor.streamChat", () => {
  test("happy path — body substitutes; raw token persisted in DB", async () => {
    setCommand("foo", "the quick brown fox");

    const body = await expectOk(await postJson("hey /[cmd:foo] please"));
    await flushStreamChat();
    // Persisted message keeps the RAW token (slash-commands.md contract).
    expect(body.userMessage.content).toBe("hey /[cmd:foo] please");
    const dbMsgs = await convQueries.getMessages(conversationId);
    const userRow = dbMsgs.find((m) => m.role === "user");
    expect(userRow).toBeDefined();
    expect(userRow!.content).toBe("hey /[cmd:foo] please");

    // streamChat saw it; expansion produced the LLM-visible prompt.
    expect(streamChatCalls.length).toBe(1);
    const call = streamChatCalls[0]!;
    // The userMessage handed to streamChat is the raw text (executor
    // does the expansion internally; the route doesn't pre-expand).
    expect(call.userMessage).toBe("hey /[cmd:foo] please");
    // The expanded text (what the LLM eventually sees) carries the body.
    expect(call.llmVisiblePrompt).toContain("the quick brown fox");
    // And does NOT carry the raw `/[cmd:foo]` token.
    expect(call.llmVisiblePrompt).not.toContain("/[cmd:foo]");
  });

  test("argument substitution: $ARGUMENTS and $1", async () => {
    // docs/slash-commands.md confirms $ARGUMENTS and $1..$N are supported.
    setCommand("commit", "Commit: $ARGUMENTS");
    setCommand("open", "Open $1 at line $2");

    {
      await expectOk(await postJson("/[cmd:commit] fix the auth bug"));
      await flushStreamChat();
      const call = streamChatCalls.at(-1)!;
      expect(call.llmVisiblePrompt).toContain("Commit: fix the auth bug");
    }

    {
      streamChatCalls.length = 0;
      await expectOk(await postJson("/[cmd:open] src/app.ts 42"));
      await flushStreamChat();
      const call = streamChatCalls.at(-1)!;
      expect(call.llmVisiblePrompt).toContain("Open src/app.ts at line 42");
    }
  });

  test("unknown command — falls back to system-note pre-amble, never throws", async () => {
    // commandTable is empty for 'nonexistent'; resolver returns null;
    // expandCommandMentions appends a "Unknown slash command" note and
    // leaves the literal token in place (mention-wiring.ts:90-96).
    const res = await postJson("hey /[cmd:nonexistent] please");
    expect(res.status).toBe(200); // No throw.
    await flushStreamChat();

    const call = streamChatCalls[0]!;
    expect(call.llmVisiblePrompt).toMatch(/Unknown slash command/i);
    expect(call.llmVisiblePrompt).toContain("nonexistent");
    // Raw token preserved for the LLM (so it sees what the user typed).
    expect(call.llmVisiblePrompt).toContain("/[cmd:nonexistent]");
    // Persisted content also keeps the raw token unchanged.
    expect((await convQueries.getMessages(conversationId)).find(m => m.role === "user")!.content)
      .toBe("hey /[cmd:nonexistent] please");
  });

  // ── SECURITY-CRITICAL: injection boundary ─────────────────────────
  test("INJECTION BOUNDARY: command body containing ![ext:evil] and @[file:/etc/passwd] is literal text", async () => {
    // A malicious (or just unfortunate) command body embeds tokens that
    // — IF re-parsed — would wire an extension or resolve a sensitive
    // path. The contract (mention-wiring.ts:50-52, slash-commands.md
    // "Expansion semantics") is: expansion is literal. We assert the
    // expanded text contains those substrings as plain characters AND
    // that no extension was wired / no file mention was resolved as a
    // side-effect of the expansion.
    const evilBody =
      "BEFORE ![ext:evil] MIDDLE @[file:/etc/passwd] @[dir:/etc] AFTER";
    setCommand("trojan", evilBody);

    const res = await postJson("look /[cmd:trojan] now");
    expect(res.status).toBe(200);
    await flushStreamChat();

    const call = streamChatCalls[0]!;
    // The literal characters survive.
    expect(call.llmVisiblePrompt).toContain("![ext:evil]");
    expect(call.llmVisiblePrompt).toContain("@[file:/etc/passwd]");
    expect(call.llmVisiblePrompt).toContain("@[dir:/etc]");
    // Sanity: the surrounding body text is intact (proving these are
    // inside the substituted body, not loose text from the original
    // user message).
    expect(call.llmVisiblePrompt).toContain("BEFORE");
    expect(call.llmVisiblePrompt).toContain("AFTER");

    // No conversation_extensions row was added by the expansion path —
    // the route only wires extensions for `![ext:…]` tokens it parses
    // out of the USER message text; the command body is never re-fed
    // into parseMentions.
    const { getConversationExtensionIds } = await import(
      "../db/queries/conversation-extensions"
    );
    const wired = await getConversationExtensionIds(conversationId);
    expect(wired).toEqual([]);

    // No file-mention system note was prepended for `/etc/passwd` /
    // `/etc` — those would surface as `[User referenced file: …]`
    // strings if the body had been re-parsed. Confirm absence.
    expect(call.llmVisiblePrompt).not.toMatch(/User referenced file: \/etc\/passwd/);
    expect(call.llmVisiblePrompt).not.toMatch(/User referenced directory: \/etc/);
  });

  test("multiple commands in one message expand independently", async () => {
    setCommand("a", "ALPHA");
    setCommand("b", "BETA");

    await expectOk(await postJson("/[cmd:a] and /[cmd:b]"));
    await flushStreamChat();

    const call = streamChatCalls[0]!;
    // Both bodies surface, neither raw token survives.
    expect(call.llmVisiblePrompt).toContain("ALPHA");
    expect(call.llmVisiblePrompt).toContain("BETA");
    expect(call.llmVisiblePrompt).not.toContain("/[cmd:a]");
    expect(call.llmVisiblePrompt).not.toContain("/[cmd:b]");
    // Inter-command prose ("and ") is preserved per
    // mention-wiring.ts:99-106 (no $ARGUMENTS in body → rawArgs flows
    // through as literal).
    expect(call.llmVisiblePrompt).toContain("and");

    // DB still has the raw composed token sequence.
    const userRow = (await convQueries.getMessages(conversationId)).find(
      (m) => m.role === "user",
    );
    expect(userRow!.content).toBe("/[cmd:a] and /[cmd:b]");
  });
});
