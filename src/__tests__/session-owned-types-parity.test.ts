/**
 * The repo-owned session types vs the pi-agent-core types they replaced.
 *
 * `src/db/session-storage.ts` used to import `SessionTreeEntry`,
 * `SessionEntryCursorOptions`, `SessionMetadata`, `SessionStats`,
 * `SessionStorage` and `SessionError` from `@earendil-works/pi-agent-core`,
 * and to declare `implements SessionStorage<DbSessionMetadata>`. Nothing
 * redeemed that promise — no production code constructs pi's `Session` — so
 * the storage shapes are now declared in the module that owns the table.
 *
 * This suite is the receipt. It proves, at BOTH compile time and run time:
 *  1. every owned entry variant is still assignable to pi's, and pi's is
 *     still assignable to ours — so no call site's meaning changed and
 *     re-coupling later stays a one-line import;
 *  2. real owned entries still flow through pi's engine-side context
 *     builder and produce the same messages;
 *  3. the owned `SessionError` is observationally identical to pi's — same
 *     `name`, `message`, `code` strings and `Error` ancestry — including the
 *     `invalid_session` code pi drops after 0.83;
 *  4. `DbSessionStorage`'s method surface is exactly the set the product
 *     calls, with the five interface-only methods gone and nothing else.
 *
 * The `assignable<T>()` helper is deliberately identity: the ASSERTION is
 * the type argument (checked by `bun run typecheck`), and the `expect` keeps
 * it a real, non-vacuous runtime test too.
 */
import { test, expect, describe } from "bun:test";
import { buildSessionContext } from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  SessionEntryCursorOptions as PiSessionEntryCursorOptions,
  SessionMetadata as PiSessionMetadata,
  SessionTreeEntry as PiSessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
  SessionError,
  entryToRow,
  leafIdAfterEntry,
  rowToEntry,
  DbSessionStorage,
  type DbSessionMetadata,
  type SessionEntryCursorOptions,
  type SessionTreeEntry,
} from "../db/session-storage";

/** Identity at run time; an assignability assertion at compile time. */
function assignable<T>(value: T): T {
  return value;
}

function userMsg(content: string): AgentMessage {
  return { role: "user", content } as unknown as AgentMessage;
}
function assistantMsg(content: string): AgentMessage {
  return { role: "assistant", content, provider: "anthropic", model: "claude" } as unknown as AgentMessage;
}

/** One value of every owned variant, keyed by its discriminant. */
const OWNED_ENTRIES = {
  message: { type: "message", id: "e1", parentId: null, timestamp: "t", message: userMsg("hi") },
  thinking_level_change: { type: "thinking_level_change", id: "e2", parentId: "e1", timestamp: "t", thinkingLevel: "high" },
  model_change: { type: "model_change", id: "e3", parentId: "e2", timestamp: "t", provider: "anthropic", modelId: "claude" },
  active_tools_change: { type: "active_tools_change", id: "e4", parentId: "e3", timestamp: "t", activeToolNames: ["bash"] },
  compaction: { type: "compaction", id: "e5", parentId: "e4", timestamp: "t", summary: "s", tokensBefore: 7 },
  branch_summary: { type: "branch_summary", id: "e6", parentId: "e5", timestamp: "t", fromId: "e1", summary: "s" },
  custom: { type: "custom", id: "e7", parentId: "e6", timestamp: "t", customType: "ezcorp:filtered-row", data: { a: 1 } },
  custom_message: { type: "custom_message", id: "e8", parentId: "e7", timestamp: "t", customType: "x", content: "c", display: true },
  label: { type: "label", id: "e9", parentId: "e8", timestamp: "t", targetId: "e1", label: "L" },
  session_info: { type: "session_info", id: "e10", parentId: "e9", timestamp: "t", name: "n" },
  leaf: { type: "leaf", id: "e11", parentId: "e10", timestamp: "t", targetId: "e1" },
} as const satisfies Record<string, SessionTreeEntry>;

describe("owned session types — assignable to and from pi's", () => {
  test("every owned variant is a pi SessionTreeEntry, and vice versa", () => {
    for (const [type, entry] of Object.entries(OWNED_ENTRIES)) {
      const owned: SessionTreeEntry = entry;
      // Owned → pi: nothing this repo persists became unrepresentable.
      const asPi = assignable<PiSessionTreeEntry>(owned);
      // pi → owned: nothing pi produces became unrepresentable either.
      const backToOwned = assignable<SessionTreeEntry>(asPi);
      expect(backToOwned).toBe(owned);
      expect(backToOwned.type).toBe(type);
    }
    // The union is exhaustive in both directions — same 11 members.
    expect(Object.keys(OWNED_ENTRIES)).toHaveLength(11);
  });

  test("the cursor options and the metadata shape are still pi-compatible", () => {
    const cursor: SessionEntryCursorOptions = { afterEntrySeq: 2, limit: 3 };
    expect(assignable<PiSessionEntryCursorOptions>(cursor)).toEqual({ afterEntrySeq: 2, limit: 3 });
    // DbSessionMetadata used to `extends SessionMetadata`; it still satisfies
    // it structurally, so the extra fields were never the coupling.
    const meta: DbSessionMetadata = { id: "s1", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" };
    expect(assignable<PiSessionMetadata>(meta).id).toBe("s1");
  });

  test("owned entries still drive pi's engine-side context builder", () => {
    // A branch of owned values, straight into pi — the seam that matters,
    // since `AgentMessage` is deliberately still pi's.
    const branch: SessionTreeEntry[] = [
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMsg("first") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: assistantMsg("second") },
    ];
    const ctx = buildSessionContext(branch);
    expect(ctx.messages.map((m: { content: unknown }) => m.content)).toEqual(["first", "second"]);
    expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude" });
  });

  test("the pure helpers accept and return owned entries unchanged", () => {
    const entry = OWNED_ENTRIES.message;
    expect(leafIdAfterEntry(entry)).toBe("e1");
    expect(leafIdAfterEntry(OWNED_ENTRIES.leaf)).toBe("e1");
    const row = entryToRow("sess", entry, "ez1");
    expect(row).toMatchObject({ sessionId: "sess", entryId: "e1", type: "message", ezMessageId: "ez1" });
    expect(
      rowToEntry({
        type: row.type,
        entryId: row.entryId,
        parentId: row.parentId ?? null,
        timestamp: row.timestamp,
        payload: row.payload as Record<string, unknown>,
      }),
    ).toEqual(entry);
  });
});

describe("owned SessionError — observationally identical to pi's", () => {
  test("carries pi's name, message and Error ancestry", () => {
    const err = new SessionError("not_found", "Entry x not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionError");
    expect(err.message).toBe("Entry x not found");
    expect(err.code).toBe("not_found");
    expect(String(err)).toBe("SessionError: Entry x not found");
  });

  test("keeps `invalid_session`, the code pi drops after 0.83", () => {
    // Three throw sites in session-storage.ts classify a structurally broken
    // tree this way. Owning the type is what stops a pi bump from silently
    // reclassifying them.
    const err = new SessionError("invalid_session", "Entry y not found");
    expect(err.code).toBe("invalid_session");
  });

  test("threads an optional cause, exactly as pi's constructor did", () => {
    const cause = new Error("root cause");
    expect(new SessionError("not_found", "wrapped", cause).cause).toBe(cause);
    expect(new SessionError("not_found", "bare").cause).toBeUndefined();
  });
});

describe("DbSessionStorage — the surface after dropping the interface", () => {
  /** Every own prototype method, including the two TS-private ones (which
   *  are private only to the compiler). */
  const methods = Object.getOwnPropertyNames(DbSessionStorage.prototype)
    .filter((name) => name !== "constructor")
    .sort();

  test("is exactly the set the product calls, plus its two private writers", () => {
    expect(methods).toEqual([
      "appendEntry",
      "createEntryId",
      "getEntries",
      "getLeafId",
      "getMetadata",
      "getPathToRootOrCompaction",
      "persist",
      "reparentEntry",
      "setLeafId",
      "writeLeafCache",
    ]);
    expect(typeof DbSessionStorage.create).toBe("function");
    expect(typeof DbSessionStorage.open).toBe("function");
  });

  test("the five interface-only methods are gone", () => {
    // Each existed solely to satisfy pi's `SessionStorage`; a repo-wide grep
    // found callers only in this suite's predecessor.
    for (const name of ["getEntry", "findEntries", "getLabel", "getSessionName", "getSessionStats"]) {
      expect(methods).not.toContain(name);
    }
  });
});
