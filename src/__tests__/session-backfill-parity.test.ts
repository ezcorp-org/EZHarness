import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Session } from "@earendil-works/pi-agent-core";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessionEntries, agentSessions, conversations, messageAttachments, messages, projects } from "../db/schema";
import type { StreamChatContext } from "../runtime/stream-chat/context";

// Must mock before importing modules that use db/connection.
mockDbConnection();

const { backfillSessionForConversation, isLlmTurn, rowToPiMessage } = await import("../db/session-backfill");
const { loadHistory } = await import("../runtime/stream-chat/load-history");

const PROJECT_ID = "p-parity";
let convSeq = 0;

async function newConversation(): Promise<string> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p" }).onConflictDoNothing();
  const convId = `conv-${++convSeq}`;
  await db.insert(conversations).values({ id: convId, projectId: PROJECT_ID, title: "C" });
  return convId;
}

interface SeedMsg {
  id: string;
  convId: string;
  role: string;
  content: string;
  parentId?: string | null;
  excluded?: boolean;
  createdAt: Date;
}

async function seedMsg(m: SeedMsg): Promise<void> {
  await getTestDb().insert(messages).values({
    id: m.id,
    conversationId: m.convId,
    role: m.role,
    content: m.content,
    parentMessageId: m.parentId ?? null,
    excluded: m.excluded ?? false,
    createdAt: m.createdAt,
  });
}

const BASE = new Date("2026-07-11T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

/** loadHistory's per-message `timestamp` is `Date.now()` — non-deterministic
 *  even between two loadHistory calls. Normalise it away before comparing;
 *  every other field is deterministic and IS compared. */
function stripTimestamps<T extends { timestamp?: unknown }>(msgs: T[]): T[] {
  return msgs.map((m) => ({ ...m, timestamp: 0 }));
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  return (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
}

/** REFERENCE branch that today's runtime feeds pi-ai: loadHistory with NO
 *  provider/model so no attachment/image rehydration fires (pastCaps null) —
 *  the pure base-mapped, branch-selected, filtered history. */
async function referenceHistory(convId: string) {
  return (await loadHistory({} as StreamChatContext, convId, {})).history;
}

/** CANDIDATE: backfill → pi Session → buildContext. */
async function candidateContext(convId: string) {
  const storage = await backfillSessionForConversation(convId);
  return (await new Session(storage).buildContext()).messages;
}

describe("session backfill — dark read-parity vs loadHistory", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("linear thread: buildContext == loadHistory (base mapping + order)", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg({ id: "a1", convId: c, role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await seedMsg({ id: "u2", convId: c, role: "user", content: "u2", parentId: "a1", createdAt: at(2) });
    await seedMsg({ id: "a2", convId: c, role: "assistant", content: "a2", parentId: "u2", createdAt: at(3) });

    const ref = await referenceHistory(c);
    const cand = await candidateContext(c);

    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
    expect(cand.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // assistant messages keep loadHistory's placeholder shape verbatim
    expect(cand[1]).toMatchObject({ role: "assistant", api: "unknown", provider: "unknown", model: "unknown", stopReason: "stop" });
    // Justify stripTimestamps (NOT a silent weakening): the session's stamps
    // are the DETERMINISTIC row createdAt, whereas loadHistory stamps every
    // message with wall-clock Date.now() — so timestamp is inherently
    // non-comparable and is the ONLY excluded field.
    expect((cand[0] as { timestamp: number }).timestamp).toBe(at(0).getTime());
  });

  test("branched thread (edit/retry): only the ACTIVE branch, siblings preserved in tree", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg({ id: "a1", convId: c, role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    // Abandoned branch A
    await seedMsg({ id: "u2", convId: c, role: "user", content: "u2-abandoned", parentId: "a1", createdAt: at(2) });
    await seedMsg({ id: "a2", convId: c, role: "assistant", content: "a2-abandoned", parentId: "u2", createdAt: at(3) });
    // Active branch B — edited u2, newer createdAt so it is the active leaf
    await seedMsg({ id: "u2b", convId: c, role: "user", content: "u2-active", parentId: "a1", createdAt: at(4) });
    await seedMsg({ id: "a2b", convId: c, role: "assistant", content: "a2-active", parentId: "u2b", createdAt: at(5) });

    const ref = await referenceHistory(c);
    const cand = await candidateContext(c);

    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
    const texts = cand.map(textOf);
    expect(texts).toEqual(["u1", "a1", "u2-active", "a2-active"]);
    expect(texts).not.toContain("u2-abandoned");
    expect(texts).not.toContain("a2-abandoned");

    // Full-tree walk: the abandoned sibling rows survive in the session tree
    // (as entries) even though they are off the active branch.
    const storage = await backfillSessionForConversation(c);
    const allIds = (await storage.getEntries()).map((e) => e.id);
    expect(allIds).toContain("u2");
    expect(allIds).toContain("a2");
  });

  test("synthetic + excluded rows on the branch are dropped identically", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "u1", parentId: null, createdAt: at(0) });
    // excluded assistant — filtered by loadHistory's .filter(!excluded)
    await seedMsg({ id: "a1x", convId: c, role: "assistant", content: "a1-excluded", parentId: "u1", excluded: true, createdAt: at(1) });
    // all three synthetic roles, chained mid-branch
    await seedMsg({ id: "pr", convId: c, role: "preprocess-result", content: "{}", parentId: "a1x", createdAt: at(2) });
    await seedMsg({ id: "ear", convId: c, role: "ez-action-result", content: "{}", parentId: "pr", createdAt: at(3) });
    await seedMsg({ id: "u2", convId: c, role: "user", content: "u2", parentId: "ear", createdAt: at(4) });
    await seedMsg({ id: "ce", convId: c, role: "capability-event", content: "{}", parentId: "u2", createdAt: at(5) });
    await seedMsg({ id: "a2", convId: c, role: "assistant", content: "a2", parentId: "ce", createdAt: at(6) });

    const ref = await referenceHistory(c);
    const cand = await candidateContext(c);

    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
    expect(cand.map(textOf)).toEqual(["u1", "u2", "a2"]);

    // The dropped rows are still present in the tree as non-emitting entries
    // (keeping the parentId chain connected) — buildContext just skips them.
    const storage = await backfillSessionForConversation(c);
    const entries = await storage.getEntries();
    const custom = entries.filter((e) => e.type === "custom");
    expect(custom.map((e) => e.id).sort()).toEqual(["a1x", "ce", "ear", "pr"]);
  });

  test("attachment thread: base parity holds; ezMessageId cross-link present (image rehydration is a documented post-transform)", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "look at this", parentId: null, createdAt: at(0) });
    await seedMsg({ id: "a1", convId: c, role: "assistant", content: "nice", parentId: "u1", createdAt: at(1) });
    await getTestDb().insert(messageAttachments).values({
      id: "att1",
      messageId: "u1",
      conversationId: c,
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: 123,
      storagePath: "/tmp/pic.png",
      kind: "image",
    });

    // With no image-capable provider in options, loadHistory does NOT
    // rehydrate — so base parity (role sequence + text) holds exactly.
    const ref = await referenceHistory(c);
    const cand = await candidateContext(c);
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));

    // The message entry carries the ezMessageId cross-link P3 uses to run
    // loadHistory's attachment/image rehydration as a post-buildContext
    // transform. DOCUMENTED EXCLUSION: under an image-capable provider,
    // loadHistory additionally lifts the user turn into image content parts
    // (rehydrateUserMessageContent) — that transform is row-keyed via this
    // cross-link and branch-invariant, so it is layered on top of the
    // session in P3, NOT stored in the session tree here. P2 proves the
    // load-bearing branch+base parity and that the cross-link exists.
    const storage = await backfillSessionForConversation(c);
    const [row] = await getTestDb()
      .select()
      .from(agentSessionEntries)
      .where(and(eq(agentSessionEntries.sessionId, (await storage.getMetadata()).id), eq(agentSessionEntries.entryId, "u1")));
    expect(row?.ezMessageId).toBe("u1");
    expect(row?.type).toBe("message");
  });

  test("idempotent: re-running backfill returns the same session with no duplicate entries", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg({ id: "a1", convId: c, role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });

    const first = await backfillSessionForConversation(c);
    const firstId = (await first.getMetadata()).id;
    const firstEntries = (await first.getEntries()).length;

    const second = await backfillSessionForConversation(c);
    expect((await second.getMetadata()).id).toBe(firstId);
    expect((await second.getEntries()).length).toBe(firstEntries);

    // Exactly one session row for the conversation.
    const sessRows = await getTestDb().select().from(agentSessionEntries).where(eq(agentSessionEntries.sessionId, firstId));
    // 2 message entries + 1 leaf pointer (setLeafId) — unchanged after re-run.
    expect(sessRows.length).toBe(3);
  });

  test("concurrent backfill: loser resolves to the same session (no unhandled unique violation)", async () => {
    const c = await newConversation();
    await seedMsg({ id: "u1", convId: c, role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg({ id: "a1", convId: c, role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });

    // Two concurrent calls both pass into DbSessionStorage.create; the INSERT
    // serializes them — one wins, the loser catches 23505 and opens the same
    // session. Must NOT throw, must resolve to one session id.
    const [s1, s2] = await Promise.all([
      backfillSessionForConversation(c),
      backfillSessionForConversation(c),
    ]);
    expect((await s1.getMetadata()).id).toBe((await s2.getMetadata()).id);

    const sessRows = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(sessRows.length).toBe(1);
  });

  test("parent absent from the loaded set is re-rooted — buildContext degrades, no invalid_session throw", async () => {
    // A parentMessageId can be FK-legal yet absent from THIS conversation's
    // rows: messages.parent_message_id is a self-FK to messages(id) (NOT
    // scoped to conversation), so a pointer can reference a row in ANOTHER
    // conversation. getMessages loads only this conversation, so that parent
    // is not in knownIds and backfill re-roots it to null — getPathToRoot
    // then degrades gracefully instead of throwing invalid_session.
    //
    // NOTE (honest scope): a *same-conversation* dangling pointer is
    // unreachable (self-FK ON DELETE SET NULL). loadHistory parity is NOT
    // asserted for this case — its recursive CTE is unfiltered by
    // conversation and would FOLLOW the cross-conversation pointer (a
    // pre-existing quirk), so the two intentionally differ here; backfill
    // prefers graceful truncation over a throw.
    const other = await newConversation();
    await seedMsg({ id: "d1", convId: other, role: "assistant", content: "d1", parentId: null, createdAt: at(0) });
    const c = await newConversation();
    await seedMsg({ id: "u2", convId: c, role: "user", content: "u2", parentId: "d1", createdAt: at(1) });
    await seedMsg({ id: "a2", convId: c, role: "assistant", content: "a2", parentId: "u2", createdAt: at(2) });

    const storage = await backfillSessionForConversation(c);
    const ctx = (await new Session(storage).buildContext()).messages; // must NOT throw
    expect(ctx.map(textOf)).toEqual(["u2", "a2"]);

    const u2entry = (await storage.getEntries()).find((e) => e.id === "u2");
    expect(u2entry?.parentId).toBeNull();
  });

  test("empty conversation: empty session, empty context, null leaf", async () => {
    const c = await newConversation();
    const storage = await backfillSessionForConversation(c);
    expect(await storage.getEntries()).toEqual([]);
    expect(await storage.getLeafId()).toBeNull();
    expect((await new Session(storage).buildContext()).messages).toEqual([]);
    expect(await referenceHistory(c)).toEqual([]);
  });
});

describe("session backfill — pure helpers", () => {
  test("isLlmTurn: real user/assistant are turns; excluded + synthetic are not", () => {
    expect(isLlmTurn({ role: "user", excluded: false })).toBe(true);
    expect(isLlmTurn({ role: "assistant", excluded: false })).toBe(true);
    expect(isLlmTurn({ role: "assistant", excluded: true })).toBe(false);
    expect(isLlmTurn({ role: "ez-action-result", excluded: false })).toBe(false);
    expect(isLlmTurn({ role: "preprocess-result", excluded: false })).toBe(false);
    expect(isLlmTurn({ role: "capability-event", excluded: false })).toBe(false);
  });

  test("rowToPiMessage: assistant → placeholder AssistantMessage; else → UserMessage", () => {
    const created = at(7);
    const asst = rowToPiMessage({ role: "assistant", content: "hi", createdAt: created } as any);
    expect(asst).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "unknown",
      provider: "unknown",
      model: "unknown",
      stopReason: "stop",
      timestamp: created.getTime(),
    });
    const usr = rowToPiMessage({ role: "user", content: "yo", createdAt: created } as any);
    expect(usr).toEqual({ role: "user", content: "yo", timestamp: created.getTime() });
  });
});
