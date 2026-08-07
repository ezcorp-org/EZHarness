import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { Session } from "@earendil-works/pi-agent-core";
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessionEntries } from "../db/schema";

// Must mock before importing modules that use db/connection.
mockDbConnection();

const {
  DbSessionStorage,
  generateEntryId,
  leafIdAfterEntry,
  updateLabelCache,
  buildLabelsById,
  entryToRow,
  rowToEntry,
  asJsonbObject,
  completeUsage,
  entryUsage,
} = await import("../db/session-storage");

// ── AgentMessage builders (pi passes `entry.message` through verbatim;
//    the exact LLM shape doesn't matter for storage semantics). ───────
function userMsg(content: string): AgentMessage {
  return { role: "user", content } as unknown as AgentMessage;
}
function assistantMsg(content: string, provider = "anthropic", model = "claude"): AgentMessage {
  return { role: "assistant", content, provider, model } as unknown as AgentMessage;
}

// ── Usage builders for the getSessionStats suite ─────────────────────
/** A complete pi `Usage` blob. Every field the guard checks is present. */
function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): any {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}
/** An assistant message carrying usage, as a persisted entry would. */
function assistantMsgWithUsage(content: string, u: any): AgentMessage {
  return { ...(assistantMsg(content) as any), usage: u } as unknown as AgentMessage;
}

// ── 0. jsonb metadata sanitization (tree-500 regression) ─────────────
describe("asJsonbObject — jsonb metadata guard", () => {
  test("keeps a plain object", () => {
    expect(asJsonbObject({ a: 1 })).toEqual({ a: 1 });
  });
  test("coerces string / array / number / null / undefined to null", () => {
    expect(asJsonbObject("")).toBeNull();
    expect(asJsonbObject("x")).toBeNull();
    expect(asJsonbObject([1, 2])).toBeNull();
    expect(asJsonbObject(3)).toBeNull();
    expect(asJsonbObject(null)).toBeNull();
    expect(asJsonbObject(undefined)).toBeNull();
  });
});

describe("DbSessionStorage — metadata never writes invalid jsonb", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("create with metadata='' persists null and getMetadata does not throw", async () => {
    // Bypass the compile-time `Record<string, unknown>` type to reproduce the
    // real-world caller that passed an empty string.
    const storage = await DbSessionStorage.create({ metadata: "" as unknown as Record<string, unknown> });
    const meta = await storage.getMetadata();
    expect(meta.metadata).toBeUndefined();
    // Re-open from the DB to prove the persisted value is valid jsonb (would
    // have thrown "Failed query" before the fix).
    const reopened = await DbSessionStorage.open(meta.id);
    expect((await reopened.getMetadata()).metadata).toBeUndefined();
  });

  test("create with a valid object round-trips", async () => {
    const storage = await DbSessionStorage.create({ metadata: { goal: "ship" } });
    const reopened = await DbSessionStorage.open((await storage.getMetadata()).id);
    expect((await reopened.getMetadata()).metadata).toEqual({ goal: "ship" });
  });
});

// ── 1. append / branch semantics (driven through pi's real Session) ──
describe("DbSessionStorage — append + branch semantics", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("append chains parentId; getBranch + buildContext return root→leaf order", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("first"));
    const id2 = await session.appendMessage(assistantMsg("second"));
    const id3 = await session.appendMessage(userMsg("third"));

    expect(await storage.getLeafId()).toBe(id3);
    expect((await storage.getEntry(id1))?.parentId).toBeNull();
    expect((await storage.getEntry(id2))?.parentId).toBe(id1);
    expect((await storage.getEntry(id3))?.parentId).toBe(id2);

    const branch = await session.getBranch();
    expect(branch.map((e) => e.id)).toEqual([id1, id2, id3]);

    const ctx = await session.buildContext();
    expect(ctx.messages.map((m: any) => m.content)).toEqual(["first", "second", "third"]);
    // deriveSessionContextState reads the latest assistant message's model.
    expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude" });
    expect(ctx.thinkingLevel).toBe("off");
  });

  test("createEntryId returns an 8-char id that does not persist", async () => {
    const storage = await DbSessionStorage.create();
    const id = await storage.createEntryId();
    expect(id).toHaveLength(8);
    expect(await storage.getEntry(id)).toBeUndefined();
    expect(await storage.getEntries()).toEqual([]);
  });

  test("getMetadata surfaces base + extended fields; optionals omitted when null", async () => {
    const withExtras = await DbSessionStorage.create({ id: "m1", cwd: "/repo", metadata: { k: "v" } });
    const md = await withExtras.getMetadata();
    expect(md.id).toBe("m1");
    expect(typeof md.createdAt).toBe("string");
    expect(md.cwd).toBe("/repo");
    expect(md.metadata).toEqual({ k: "v" });
    expect(md.conversationId).toBeUndefined();
    expect(md.parentSessionId).toBeUndefined();

    const bare = await DbSessionStorage.create({ id: "m2" });
    const md2 = await bare.getMetadata();
    expect(md2.cwd).toBeUndefined();
    expect(md2.metadata).toBeUndefined();
    // Reachable through pi's Session too.
    expect((await new Session(bare).getMetadata()).id).toBe("m2");
  });

  test("session links to a conversation (FK + conversationId metadata, survives reopen)", async () => {
    const db = getTestDb();
    await db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('p1','P','/tmp/p') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES ('c1','p1','C')`);
    // Parent must exist — the self-referential FK on parent_session_id is real.
    await DbSessionStorage.create({ id: "root-sess" });
    const storage = await DbSessionStorage.create({ id: "sconv", conversationId: "c1", parentSessionId: "root-sess" });
    const md = await storage.getMetadata();
    expect(md.conversationId).toBe("c1");
    expect(md.parentSessionId).toBe("root-sess");

    const reopened = await DbSessionStorage.open("sconv");
    expect((await reopened.getMetadata()).conversationId).toBe("c1");
    // A conversation-less session opens fine (empty entry set).
    expect(await reopened.getEntries()).toEqual([]);
    expect(await reopened.getLeafId()).toBeNull();
  });
});

// ── 2. leaf semantics: rewind + recovery on reopen ──────────────────
describe("DbSessionStorage — leaf / rewind semantics", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("moveTo rewinds the leaf; the abandoned tail survives on the insertion axis", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    const id2 = await session.appendMessage(assistantMsg("a1"));
    const id3 = await session.appendMessage(userMsg("u2-tail"));

    await session.moveTo(id1);
    expect(await storage.getLeafId()).toBe(id1);

    const id4 = await session.appendMessage(assistantMsg("a1-alt"));
    expect((await storage.getEntry(id4))?.parentId).toBe(id1);

    const branch = await session.getBranch();
    expect(branch.map((e) => e.id)).toEqual([id1, id4]);

    const all = (await storage.getEntries()).map((e) => e.id);
    expect(all).toContain(id2);
    expect(all).toContain(id3);
  });

  test("moveTo with a summary records a branch_summary entry", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    await session.appendMessage(assistantMsg("a1"));
    await session.moveTo(id1, { summary: "abandoned that path" });

    const summaries = await storage.findEntries("branch_summary");
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as any).summary).toBe("abandoned that path");
    expect((summaries[0] as any).fromId).toBe(id1);
  });

  test("leaf recovery on reopen replays entries incl. a leaf pointer", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-reopen" });
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    const id2 = await session.appendMessage(assistantMsg("a1"));
    await session.moveTo(id1); // appends a leaf pointer → leaf = id1

    const reopened = await DbSessionStorage.open("sess-reopen");
    expect(await reopened.getLeafId()).toBe(id1);
    const entries = await reopened.getEntries();
    expect(entries.some((e) => e.type === "leaf")).toBe(true);
    expect(entries.filter((e) => e.type === "message").map((e) => e.id)).toEqual([id1, id2]);
  });

  test("setLeafId(null) clears the leaf and the empty branch survives reopen", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-null" });
    const session = new Session(storage);
    await session.appendMessage(userMsg("u1"));
    await storage.setLeafId(null);
    expect(await storage.getLeafId()).toBeNull();
    expect(await storage.getPathToRootOrCompaction(null)).toEqual([]);

    const reopened = await DbSessionStorage.open("sess-null");
    expect(await reopened.getLeafId()).toBeNull();
    // The leaf-pointer entry was persisted even though the leaf is null.
    expect((await reopened.getEntries()).some((e) => e.type === "leaf")).toBe(true);
  });
});

describe("DbSessionStorage — reparentEntry (P3 topology reconcile)", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("changed parent updates in-memory + DB (survives reopen); unchanged is a no-op; missing throws", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-reparent" });
    await storage.appendEntry({ type: "message", id: "e1", parentId: null, timestamp: "t", message: userMsg("u1") });
    await storage.appendEntry({ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: assistantMsg("a1") });
    await storage.appendEntry({ type: "message", id: "e3", parentId: "e1", timestamp: "t", message: userMsg("u2") });

    // Change: reparent e3 from e1 → e2. getPathToRootOrCompaction must follow the new parent.
    await storage.reparentEntry("e3", "e2");
    expect((await storage.getEntry("e3"))?.parentId).toBe("e2");
    expect((await storage.getPathToRootOrCompaction("e3")).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);

    // Persisted across reopen.
    const reopened = await DbSessionStorage.open("sess-reparent");
    expect((await reopened.getEntry("e3"))?.parentId).toBe("e2");

    // No-op when the parent is already the desired value (early return, no write).
    await storage.reparentEntry("e3", "e2");
    expect((await storage.getEntry("e3"))?.parentId).toBe("e2");

    // Unknown entry rejects.
    await expect(storage.reparentEntry("nope", null)).rejects.toThrow();
  });
});

// ── 3. insertion-order axis + findEntries ───────────────────────────
describe("DbSessionStorage — insertion order vs tree order", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("getEntries is seq (insertion) order, distinct from tree order", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    const id2 = await session.appendMessage(assistantMsg("a1"));
    await session.moveTo(id1); // 3rd insert = leaf pointer
    const id4 = await session.appendMessage(userMsg("u2-branch")); // 4th insert, parent id1

    const insertion = (await storage.getEntries()).map((e) => e.id);
    expect(insertion).toHaveLength(4);
    expect(insertion[0]).toBe(id1);
    expect(insertion[1]).toBe(id2);
    expect(insertion[3]).toBe(id4);

    // Tree order is a SEPARATE axis: the branch skips the abandoned a1.
    const branch = (await storage.getPathToRootOrCompaction(await storage.getLeafId())).map((e) => e.id);
    expect(branch).toEqual([id1, id4]);
    expect(branch).not.toContain(id2);
  });

  test("findEntries filters by type in insertion order", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    await session.appendMessage(userMsg("u1"));
    await session.appendMessage(assistantMsg("a1"));
    await session.appendSessionName("my session");

    const msgs = await storage.findEntries("message");
    expect(msgs).toHaveLength(2);
    expect(msgs.every((e) => e.type === "message")).toBe(true);

    const infos = await storage.findEntries("session_info");
    expect(infos).toHaveLength(1);
    expect((infos[0] as any).name).toBe("my session");
    expect(await storage.findEntries("compaction")).toHaveLength(0);
  });
});

// ── 4. labels: latest-non-empty-wins derived cache, survives reopen ──
describe("DbSessionStorage — label cache", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("latest non-empty label wins; whitespace clears; both survive reopen", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-label" });
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    await session.appendLabel(id1, "first");
    expect(await storage.getLabel(id1)).toBe("first");
    await session.appendLabel(id1, "second");
    expect(await storage.getLabel(id1)).toBe("second");

    const reopened = await DbSessionStorage.open("sess-label");
    expect(await reopened.getLabel(id1)).toBe("second");

    // A whitespace-only label clears the cache entry.
    await new Session(reopened).appendLabel(id1, "   ");
    expect(await reopened.getLabel(id1)).toBeUndefined();

    const reopened2 = await DbSessionStorage.open("sess-label");
    expect(await reopened2.getLabel(id1)).toBeUndefined();
  });
});

// ── 5. fork-shaped data: shared entry ids across sessions (PK proof) ─
describe("DbSessionStorage — fork PK + intra-session collision", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("two sessions may share an entry id; duplicate within one session rejects", async () => {
    const a = await DbSessionStorage.create({ id: "sess-a" });
    const b = await DbSessionStorage.create({ id: "sess-b" });
    const shared: SessionTreeEntry = {
      type: "message",
      id: "shared01",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: userMsg("shared"),
    };
    await a.appendEntry(shared);
    // Same entry id in a DIFFERENT session — allowed (PK is composite).
    await b.appendEntry({ ...shared });
    expect((await a.getEntry("shared01"))?.id).toBe("shared01");
    expect((await b.getEntry("shared01"))?.id).toBe("shared01");

    // Duplicate id WITHIN the same session rejects on the PK.
    await expect(a.appendEntry({ ...shared })).rejects.toThrow();
    // Memory stayed consistent — still exactly one entry.
    expect(await a.getEntries()).toHaveLength(1);
  });
});

// ── 6. jsonb + timestamp fidelity (PGlite round-trip + Bun.sql binding) ─
describe("DbSessionStorage — payload + timestamp fidelity", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("nested/unicode AgentMessage round-trips deeply on PGlite", async () => {
    const rich = {
      role: "assistant",
      provider: "anthropic",
      model: "claude",
      content: [
        { type: "text", text: 'héllo 🎉 — ünïcode ✅\n\ttabs "quotes" \\backslash' },
        { type: "tool_use", id: "t1", name: "search", input: { q: "café", nested: { a: [1, 2, { b: null }] } } },
      ],
      usage: { in: 10, out: 20 },
    } as unknown as AgentMessage;
    const storage = await DbSessionStorage.create({ id: "sess-fidelity" });
    const id = await new Session(storage).appendMessage(rich);

    const reopened = await DbSessionStorage.open("sess-fidelity");
    const entry = await reopened.getEntry(id);
    expect((entry as any).message).toEqual(rich);
    // Value-level byte fidelity: unicode + deep nesting survive verbatim.
    const got = (entry as any).message;
    expect(got.content[0].text).toBe((rich as any).content[0].text);
    expect(got.content[1].input.nested.a[2].b).toBeNull();
  });

  test("timestamp round-trips VERBATIM as pi's ISO string (TEXT column)", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-ts" });
    const ts = "2026-07-11T12:34:56.789Z";
    await storage.appendEntry({ type: "message", id: "ts01", parentId: null, timestamp: ts, message: userMsg("x") });
    const reopened = await DbSessionStorage.open("sess-ts");
    expect((await reopened.getEntry("ts01"))?.timestamp).toBe(ts);
  });

  test("Bun.sql path: identity mapToDriverValue binds the payload natively (no double-encode)", async () => {
    // Repo precedent: jsonb-double-encoding.test.ts. There's no reliable
    // external Postgres in unit tests, so we prove the drizzle+Bun.sql
    // BINDING contract at the builder level: with the connection.ts
    // initPostgres identity override installed, the column-mapped insert
    // binds the payload OBJECT (not a JSON string) — which is exactly what
    // stops the Bun.sql jsonb double-encode. LIMITATION: the live external
    // -PG round-trip itself is not exercised here (same as the precedent).
    const { PgJsonb } = await import("drizzle-orm/pg-core/columns/jsonb");
    const original = (PgJsonb.prototype as any).mapToDriverValue;
    const payload = { message: { role: "user", content: "héllo 🎉" } };
    const build = () =>
      getTestDb()
        .insert(agentSessionEntries)
        .values({ sessionId: "s", entryId: "e", type: "message", parentId: null, timestamp: "t", payload })
        .toSQL();
    try {
      // The DEFAULT drizzle mapper is JSON.stringify — the value Bun.sql
      // would bind as TEXT and store as a jsonb STRING scalar (the bug).
      expect(build().params).toContain(JSON.stringify(payload));
      // connection.ts swaps it for identity so Bun.sql serializes natively.
      (PgJsonb.prototype as any).mapToDriverValue = (v: unknown) => v;
      const params = build().params;
      expect(params).toContainEqual(payload);
      expect(params).not.toContain(JSON.stringify(payload));
    } finally {
      (PgJsonb.prototype as any).mapToDriverValue = original;
    }
  });
});

// ── 7. compaction transform driven through the storage ──────────────
describe("DbSessionStorage — compaction context transform", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("compaction on branch drops pre-firstKeptEntryId and injects the summary", async () => {
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    await session.appendMessage(userMsg("m1-dropped"));
    const id2 = await session.appendMessage(userMsg("m2-kept"));
    await session.appendMessage(assistantMsg("m3-kept"));
    await session.appendCompaction("SUMMARY-TEXT", id2, 4321);
    await session.appendMessage(userMsg("m4-post"));

    const ctx = await session.buildContext();
    expect((ctx.messages[0] as any).role).toBe("compactionSummary");
    expect((ctx.messages[0] as any).summary).toBe("SUMMARY-TEXT");
    expect((ctx.messages[0] as any).tokensBefore).toBe(4321);

    const kept = ctx.messages.slice(1).map((m: any) => m.content);
    expect(kept).toEqual(["m2-kept", "m3-kept", "m4-post"]);
    expect(ctx.messages.some((m: any) => m.content === "m1-dropped")).toBe(false);
  });
});

// ── 8. pi-agent-core 0.83.0 SessionStorage additions ────────────────
// getSessionName / getSessionStats / the getEntries cursor / the compaction
// stop in getPathToRootOrCompaction. Each is a port of memory-storage.js;
// these assert the ported SEMANTICS, not just that the methods exist.

describe("DbSessionStorage — getSessionName", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("undefined with no session_info; latest non-blank wins; blank clears; survives reopen", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-name" });
    const session = new Session(storage);
    // EZCorp's own producer never writes session_info, so this is the
    // realistic steady state.
    expect(await storage.getSessionName()).toBeUndefined();

    await session.appendSessionName("  first name  ");
    expect(await storage.getSessionName()).toBe("first name");

    // LAST entry wins (insertion order), not first.
    await session.appendSessionName("second name");
    expect(await storage.getSessionName()).toBe("second name");

    // Read back off the DB, not the in-memory append.
    expect(await (await DbSessionStorage.open("sess-name")).getSessionName()).toBe("second name");

    // A whitespace-only name is treated as unset (`.trim() || undefined`).
    await session.appendSessionName("   ");
    expect(await storage.getSessionName()).toBeUndefined();
    // …as is a session_info entry with no name at all.
    await storage.appendEntry({ type: "session_info", id: "si-x", parentId: null, timestamp: "t" });
    expect(await storage.getSessionName()).toBeUndefined();
  });
});

describe("DbSessionStorage — getSessionStats", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("empty session is all zeros", async () => {
    expect(await (await DbSessionStorage.create()).getSessionStats()).toEqual({
      messageCount: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
      totalTokens: 0,
      costTotal: 0,
    });
  });

  test("sums assistant + compaction + branch_summary usage; counts every message entry", async () => {
    const storage = await DbSessionStorage.create({ id: "sess-stats" });
    // messageCount counts BOTH roles; only the assistant turn carries usage.
    await storage.appendEntry({ type: "message", id: "u1", parentId: null, timestamp: "t", message: userMsg("q") });
    await storage.appendEntry({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "t",
      message: assistantMsgWithUsage("a", usage(10, 20, 5, 3, 0.5)),
    });
    // Entry-level usage on the two summary entry types.
    await storage.appendEntry({
      type: "branch_summary",
      id: "bs1",
      parentId: "a1",
      timestamp: "t",
      fromId: "u1",
      summary: "s",
      usage: usage(1, 2, 3, 4, 0.25),
    } as unknown as SessionTreeEntry);
    await storage.appendEntry({
      type: "compaction",
      id: "cp1",
      parentId: "bs1",
      timestamp: "t",
      summary: "s",
      tokensBefore: 99,
      usage: usage(100, 0, 0, 0, 1),
    } as unknown as SessionTreeEntry);
    // Entries with no usage concept at all must not perturb the totals.
    await storage.appendEntry({ type: "leaf", id: "lf1", parentId: null, timestamp: "t", targetId: "cp1" });

    const stats = await storage.getSessionStats();
    expect(stats.messageCount).toBe(2);
    // cachedTokens = Σ cacheRead
    expect(stats.cachedTokens).toBe(5 + 3 + 0);
    // uncachedTokens = Σ (input + cacheWrite)
    expect(stats.uncachedTokens).toBe(10 + 3 + (1 + 4) + 100);
    // totalTokens = Σ (input + output + cacheRead + cacheWrite)
    expect(stats.totalTokens).toBe(38 + 10 + 100);
    expect(stats.costTotal).toBeCloseTo(1.75, 10);

    // Reopening rebuilds from the DB and derives the same totals.
    expect(await (await DbSessionStorage.open("sess-stats")).getSessionStats()).toEqual(stats);
  });

  test("a MALFORMED persisted usage blob is skipped, not summed as NaN", async () => {
    // `payload` is jsonb — a partial usage object is representable, and
    // summing it would poison every total with NaN.
    const storage = await DbSessionStorage.create();
    await storage.appendEntry({
      type: "message",
      id: "bad",
      parentId: null,
      timestamp: "t",
      message: { role: "assistant", content: "x", usage: { input: 1 } } as unknown as AgentMessage,
    });
    const stats = await storage.getSessionStats();
    expect(stats.messageCount).toBe(1);
    expect(stats.totalTokens).toBe(0);
    expect(Number.isNaN(stats.costTotal)).toBe(false);
  });

  test("counts the ABANDONED tail too (insertion axis, not the active branch)", async () => {
    // pi sums what the session COST, so a rewound-past turn still counts.
    const storage = await DbSessionStorage.create();
    const session = new Session(storage);
    const id1 = await session.appendMessage(userMsg("u1"));
    await session.appendMessage(assistantMsgWithUsage("abandoned", usage(7, 0, 0, 0, 0.1)));
    await session.moveTo(id1);

    const stats = await storage.getSessionStats();
    expect((await storage.getPathToRootOrCompaction(await storage.getLeafId())).map((e) => e.id)).toEqual([id1]);
    expect(stats.totalTokens).toBe(7);
    expect(stats.costTotal).toBeCloseTo(0.1, 10);
  });
});

describe("DbSessionStorage — getEntries cursor window", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  /** Five message entries in insertion order, ids e0..e4. */
  async function seedFive() {
    const storage = await DbSessionStorage.create();
    for (let i = 0; i < 5; i++) {
      await storage.appendEntry({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        timestamp: "t",
        message: userMsg(`m${i}`),
      });
    }
    return storage;
  }

  test("no argument returns every entry, as a COPY the caller cannot mutate into the store", async () => {
    const storage = await seedFive();
    const all = await storage.getEntries();
    expect(all.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    all.length = 0;
    expect((await storage.getEntries()).map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  test("afterEntrySeq is a POSITION in this session's list, and limit windows from it", async () => {
    const storage = await seedFive();
    expect((await storage.getEntries({ afterEntrySeq: 2 })).map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
    expect((await storage.getEntries({ limit: 2 })).map((e) => e.id)).toEqual(["e0", "e1"]);
    expect((await storage.getEntries({ afterEntrySeq: 1, limit: 2 })).map((e) => e.id)).toEqual(["e1", "e2"]);
    // Past the end / zero-width windows are empty, never an error.
    expect(await storage.getEntries({ afterEntrySeq: 99 })).toEqual([]);
    expect(await storage.getEntries({ limit: 0 })).toEqual([]);
  });

  test("the cursor is NOT the bigserial `seq` column (which is global and gappy)", async () => {
    // A second session interleaves inserts, so this session's rows own a
    // non-contiguous slice of the shared bigserial. Position 0 must still be
    // THIS session's first entry.
    const other = await DbSessionStorage.create();
    await other.appendEntry({ type: "message", id: "x0", parentId: null, timestamp: "t", message: userMsg("x") });
    const storage = await seedFive();
    await other.appendEntry({ type: "message", id: "x1", parentId: "x0", timestamp: "t", message: userMsg("x") });

    expect((await storage.getEntries({ afterEntrySeq: 0, limit: 1 })).map((e) => e.id)).toEqual(["e0"]);
    expect((await other.getEntries({ afterEntrySeq: 1 })).map((e) => e.id)).toEqual(["x1"]);
  });
});

describe("DbSessionStorage — getPathToRootOrCompaction stops at a compaction", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  /** m0 → m1 → m2 → <compaction cp> → m3, with `cp` built by `make`. */
  async function seedCompacted(make: (parentId: string) => SessionTreeEntry) {
    const storage = await DbSessionStorage.create();
    for (let i = 0; i < 3; i++) {
      await storage.appendEntry({
        type: "message",
        id: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        timestamp: "t",
        message: userMsg(`m${i}`),
      });
    }
    await storage.appendEntry(make("m2"));
    await storage.appendEntry({ type: "message", id: "m3", parentId: "cp", timestamp: "t", message: userMsg("m3") });
    return storage;
  }

  test("firstKeptEntryId bounds how far back the walk goes", async () => {
    const storage = await seedCompacted((parentId) => ({
      type: "compaction",
      id: "cp",
      parentId,
      timestamp: "t",
      summary: "s",
      tokensBefore: 1,
      firstKeptEntryId: "m1",
    } as unknown as SessionTreeEntry));
    // m0 was summarized into `cp` and is NOT re-walked; m1 is the boundary.
    expect((await storage.getPathToRootOrCompaction("m3")).map((e) => e.id)).toEqual(["m1", "m2", "cp", "m3"]);
  });

  test("a retainedTail compaction ends the walk at the compaction itself", async () => {
    const storage = await seedCompacted((parentId) => ({
      type: "compaction",
      id: "cp",
      parentId,
      timestamp: "t",
      summary: "s",
      tokensBefore: 1,
      retainedTail: [userMsg("kept")],
    } as unknown as SessionTreeEntry));
    expect((await storage.getPathToRootOrCompaction("m3")).map((e) => e.id)).toEqual(["cp", "m3"]);
  });

  test("a compaction with NEITHER field walks all the way to the root", async () => {
    const storage = await seedCompacted((parentId) => ({
      type: "compaction",
      id: "cp",
      parentId,
      timestamp: "t",
      summary: "s",
      tokensBefore: 1,
    } as unknown as SessionTreeEntry));
    expect((await storage.getPathToRootOrCompaction("m3")).map((e) => e.id)).toEqual(["m0", "m1", "m2", "cp", "m3"]);
  });

  test("EZCorp's own entry types never take the early exit", async () => {
    // The producer (session-sync.ts) appends message / custom /
    // branch_summary only — never compaction — so the rename is behaviour-
    // preserving for every stored EZCorp tree.
    const storage = await DbSessionStorage.create();
    await storage.appendEntry({ type: "message", id: "p0", parentId: null, timestamp: "t", message: userMsg("a") });
    await storage.appendEntry({ type: "custom", id: "p1", parentId: "p0", timestamp: "t", customType: "x" });
    await storage.appendEntry({
      type: "branch_summary",
      id: "p2",
      parentId: "p1",
      timestamp: "t",
      fromId: "p0",
      summary: "s",
    } as unknown as SessionTreeEntry);
    await storage.appendEntry({ type: "message", id: "p3", parentId: "p2", timestamp: "t", message: userMsg("b") });
    expect((await storage.getPathToRootOrCompaction("p3")).map((e) => e.id)).toEqual(["p0", "p1", "p2", "p3"]);
  });
});

// ── error / recovery paths ──────────────────────────────────────────
describe("DbSessionStorage — error paths", () => {
  beforeEach(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("open() throws for a missing session", async () => {
    await expect(DbSessionStorage.open("nope")).rejects.toThrow(/not found/i);
  });

  test("open() throws when the replayed leaf points at a missing entry", async () => {
    const storage = await DbSessionStorage.create({ id: "corrupt" });
    // appendEntry does NOT validate targetId (faithful to jsonl) — a leaf
    // pointing at a ghost id makes the replayed leaf unrecoverable on open.
    await storage.appendEntry({ type: "leaf", id: "lf01", parentId: null, timestamp: "t", targetId: "ghost" });
    await expect(DbSessionStorage.open("corrupt")).rejects.toThrow(/not found/i);
  });

  test("getLeafId() throws when the in-memory leaf points at a missing entry", async () => {
    const storage = await DbSessionStorage.create();
    await storage.appendEntry({ type: "leaf", id: "lf02", parentId: null, timestamp: "t", targetId: "ghost2" });
    await expect(storage.getLeafId()).rejects.toThrow(/not found/i);
  });

  test("setLeafId() throws for a non-existent target", async () => {
    const storage = await DbSessionStorage.create();
    await expect(storage.setLeafId("nope")).rejects.toThrow(/not found/i);
  });

  test("getPathToRootOrCompaction: null → [], missing leaf → throws, ghost parent → throws", async () => {
    const storage = await DbSessionStorage.create();
    expect(await storage.getPathToRootOrCompaction(null)).toEqual([]);
    await expect(storage.getPathToRootOrCompaction("missing")).rejects.toThrow(/not found/i);
    await storage.appendEntry({ type: "message", id: "c1", parentId: "ghostp", timestamp: "t", message: userMsg("x") });
    await expect(storage.getPathToRootOrCompaction("c1")).rejects.toThrow(/not found/i);
  });
});

// ── pure helper units (incl. the after-100-collisions fallback) ─────
describe("session-storage pure helpers", () => {
  test("leafIdAfterEntry: leaf → targetId, else own id", () => {
    expect(leafIdAfterEntry({ type: "leaf", id: "L", parentId: null, timestamp: "t", targetId: "X" })).toBe("X");
    expect(leafIdAfterEntry({ type: "message", id: "M", parentId: null, timestamp: "t", message: userMsg("m") })).toBe("M");
  });

  test("generateEntryId returns an 8-char id and falls back to full uuid after 100 collisions", () => {
    expect(generateEntryId(new Map())).toHaveLength(8);
    // A generator whose 8-char tail already collides forces the fallback.
    const fixed = "aaaaaaaabbbb"; // slice(-8) = "aaaabbbb"
    const byId = new Map<string, SessionTreeEntry>([
      ["aaaabbbb", { type: "message", id: "aaaabbbb", parentId: null, timestamp: "t", message: userMsg("m") }],
    ]);
    expect(generateEntryId(byId, () => fixed)).toBe(fixed);
  });

  test("updateLabelCache + buildLabelsById: latest non-empty wins, empty clears", () => {
    const entries: SessionTreeEntry[] = [
      { type: "label", id: "l1", parentId: null, timestamp: "t", targetId: "T", label: "one" },
      { type: "label", id: "l2", parentId: null, timestamp: "t", targetId: "T", label: "two" },
      { type: "message", id: "m", parentId: null, timestamp: "t", message: userMsg("m") },
    ];
    const cache = buildLabelsById(entries);
    expect(cache.get("T")).toBe("two");
    updateLabelCache(cache, { type: "label", id: "l3", parentId: null, timestamp: "t", targetId: "T", label: "  " });
    expect(cache.get("T")).toBeUndefined();
  });

  test("completeUsage: accepts a full blob, rejects undefined / any missing counter / a missing cost.total", () => {
    const full = usage(1, 2, 3, 4, 0.5);
    expect(completeUsage(full)).toBe(full);
    expect(completeUsage(undefined)).toBeUndefined();
    // Each of the four token counters is individually load-bearing.
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
      expect(completeUsage({ ...full, [field]: "3" })).toBeUndefined();
      expect(completeUsage({ ...full, [field]: undefined })).toBeUndefined();
    }
    // …as is cost.total, including when `cost` itself is absent.
    expect(completeUsage({ ...full, cost: { ...full.cost, total: undefined } })).toBeUndefined();
    expect(completeUsage({ ...full, cost: undefined })).toBeUndefined();
  });

  test("entryUsage: assistant message → message.usage; compaction/branch_summary → entry.usage; else undefined", () => {
    const u = usage(1, 1, 1, 1, 0.1);
    expect(entryUsage({ type: "message", id: "a", parentId: null, timestamp: "t", message: assistantMsgWithUsage("x", u) })).toBe(u);
    // A user turn has no usage even though it IS a message entry.
    expect(entryUsage({ type: "message", id: "u", parentId: null, timestamp: "t", message: userMsg("x") })).toBeUndefined();
    expect(entryUsage({ type: "compaction", id: "c", parentId: null, timestamp: "t", summary: "s", tokensBefore: 1, usage: u } as any)).toBe(u);
    expect(entryUsage({ type: "branch_summary", id: "b", parentId: null, timestamp: "t", fromId: "x", summary: "s", usage: u } as any)).toBe(u);
    // A summary entry that carries no usage, and a type that never can.
    expect(entryUsage({ type: "branch_summary", id: "b2", parentId: null, timestamp: "t", fromId: "x", summary: "s" } as any)).toBeUndefined();
    expect(entryUsage({ type: "leaf", id: "l", parentId: null, timestamp: "t", targetId: null })).toBeUndefined();
  });

  test("entryToRow / rowToEntry are inverse (base columns + payload)", () => {
    const entry: SessionTreeEntry = {
      type: "message",
      id: "e1",
      parentId: "p0",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: userMsg("hi"),
    };
    const row = entryToRow("sess", entry);
    expect(row).toMatchObject({
      sessionId: "sess",
      entryId: "e1",
      type: "message",
      parentId: "p0",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { message: { role: "user", content: "hi" } },
    });
    const back = rowToEntry({
      type: row.type,
      entryId: row.entryId,
      parentId: row.parentId ?? null,
      timestamp: row.timestamp,
      payload: row.payload as Record<string, unknown>,
    });
    expect(back).toEqual(entry);
  });
});
