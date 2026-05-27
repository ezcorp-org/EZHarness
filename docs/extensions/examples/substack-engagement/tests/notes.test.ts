import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  scanNotes,
  readTargetedNoteRefs,
  _setNotesStoreForTests,
} from "../lib/notes";
import {
  list,
  get,
  approve,
  _setQueueStoreForTests,
  _setClockForTests,
  _resetQueueForTests,
  type QueueStoreLike,
} from "../lib/review-queue";
import {
  sendApproved,
  _setLlmForTests,
  _setVoiceStoreForTests,
  _setPacingStoreForTests,
  _setRngForTests,
  setDraftConfig,
} from "../lib/tools";
import {
  _setSubstackClientForTests,
  _resetSubstackClientForTests,
  type SubstackClient,
  type Note,
} from "../lib/substack-client";
import type { DraftLlm } from "../lib/voice";

// ── Fakes ───────────────────────────────────────────────────────

function makeStore() {
  const map = new Map<string, unknown>();
  const store: QueueStoreLike = {
    async get<T>(key: string) {
      if (map.has(key)) return { value: map.get(key) as T, exists: true };
      return { value: null, exists: false };
    },
    async set<T>(key: string, value: T) {
      map.set(key, value);
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      const had = map.has(key);
      map.delete(key);
      return { deleted: had };
    },
  };
  return { map, store };
}

function makeLlm(answer = "note draft"): DraftLlm {
  return {
    async complete() {
      return { content: answer };
    },
  };
}

function notesStore(refs: string[] | null) {
  return {
    async get<T>(key: string) {
      if (key === "__entity:targeted-notes-list:default" && refs !== null) {
        return { value: { name: "x", noteRefs: refs } as T, exists: true };
      }
      return { value: null as T, exists: false };
    },
  };
}

function makeClient(opts: {
  notes?: Record<string, Note>;
  listThrows?: (ref: string) => boolean;
} = {}) {
  const sent: Array<{ ref: string; body: string }> = [];
  const client: SubstackClient = {
    async listOwnPostComments() {
      return [];
    },
    async postCommentReply() {
      return { ok: true };
    },
    async listNewSubscribers(c) {
      return { subscribers: [], cursor: c ?? "" };
    },
    async sendDirectMessage() {
      return { ok: true };
    },
    async listNote(ref) {
      if (opts.listThrows?.(ref)) throw new Error(`fetch failed for ${ref}`);
      return opts.notes?.[ref] ?? { id: ref, author: "", body: "" };
    },
    async postNoteComment({ noteId, body }) {
      sent.push({ ref: noteId, body });
      return { ok: true };
    },
  };
  return { client, sent };
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text);
}

let kit: ReturnType<typeof makeStore>;
let pacingKit: ReturnType<typeof makeStore>;
let counter = 0;

beforeEach(() => {
  kit = makeStore();
  pacingKit = makeStore();
  _setQueueStoreForTests(kit.store);
  _setPacingStoreForTests(pacingKit.store);
  counter = 0;
  _setClockForTests(() => 1_000, () => `q-${counter++}`);
  _setLlmForTests(makeLlm());
  _setVoiceStoreForTests(null);
  _setRngForTests(() => 0); // no jitter in tests
  setDraftConfig({ provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 256 });
});

afterEach(() => {
  _resetQueueForTests();
  _resetSubstackClientForTests();
  _setLlmForTests(null);
  _setVoiceStoreForTests(null);
  _setNotesStoreForTests(null);
  _setPacingStoreForTests(null);
});

const SETTINGS = {
  invocationMetadata: {
    settings: {
      substack_publication_url: "https://me.substack.com",
      substack_session_token: "tok",
      substack_user_id: "1",
    },
  },
};

// ── readTargetedNoteRefs ────────────────────────────────────────

describe("readTargetedNoteRefs", () => {
  test("returns [] when no store is bound", async () => {
    _setNotesStoreForTests(null);
    expect(await readTargetedNoteRefs()).toEqual([]);
  });

  test("returns [] when the entity is absent", async () => {
    _setNotesStoreForTests(notesStore(null));
    expect(await readTargetedNoteRefs()).toEqual([]);
  });

  test("dedupes + trims + drops empties", async () => {
    _setNotesStoreForTests(notesStore(["n-1", " n-1 ", "", "  ", "n-2"]));
    expect(await readTargetedNoteRefs()).toEqual(["n-1", "n-2"]);
  });
});

// ── scan_notes ──────────────────────────────────────────────────

describe("scan_notes", () => {
  test("drafts a note-comment per targeted note with a body", async () => {
    _setNotesStoreForTests(notesStore(["n-1", "n-2"]));
    const { client } = makeClient({
      notes: {
        "n-1": { id: "n-1", author: "a", body: "hot take" },
        "n-2": { id: "n-2", author: "b", body: "another" },
      },
    });
    _setSubstackClientForTests(client);

    const out = parse(await scanNotes({}, SETTINGS));
    expect(out.targeted).toBe(2);
    expect(out.drafted).toBe(2);
    const queued = await list({ kind: "note-comment" });
    expect(queued).toHaveLength(2);
    expect(queued.every((i) => i.status === "pending")).toBe(true);
    expect(queued[0]?.draft_body).toBe("note draft");
    expect(queued.map((i) => i.target_ref).sort()).toEqual(["n-1", "n-2"]);
  });

  test("dedupes — a re-scan does not double-queue", async () => {
    _setNotesStoreForTests(notesStore(["n-1"]));
    const { client } = makeClient({ notes: { "n-1": { id: "n-1", author: "a", body: "x" } } });
    _setSubstackClientForTests(client);
    await scanNotes({}, SETTINGS);
    const second = parse(await scanNotes({}, SETTINGS));
    expect(second.drafted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await list({ kind: "note-comment" })).toHaveLength(1);
  });

  test("a missing / empty-body note is a soft skip (no enqueue)", async () => {
    _setNotesStoreForTests(notesStore(["n-empty"]));
    const { client } = makeClient({ notes: { "n-empty": { id: "n-empty", author: "a", body: "  " } } });
    _setSubstackClientForTests(client);
    const out = parse(await scanNotes({}, SETTINGS));
    expect(out.drafted).toBe(0);
    expect(out.missing).toBe(1);
    expect(await list({ kind: "note-comment" })).toHaveLength(0);
  });

  test("a per-note fetch error is reported without aborting the scan", async () => {
    _setNotesStoreForTests(notesStore(["n-bad", "n-ok"]));
    const { client } = makeClient({
      notes: { "n-ok": { id: "n-ok", author: "a", body: "fine" } },
      listThrows: (ref) => ref === "n-bad",
    });
    _setSubstackClientForTests(client);
    const out = parse(await scanNotes({}, SETTINGS));
    expect(out.drafted).toBe(1);
    expect(out.failed).toBe(1);
    expect(Array.isArray(out.failures)).toBe(true);
  });

  test("a draft failure is reported per-note", async () => {
    _setNotesStoreForTests(notesStore(["n-1"]));
    const { client } = makeClient({ notes: { "n-1": { id: "n-1", author: "a", body: "x" } } });
    _setSubstackClientForTests(client);
    _setLlmForTests({
      async complete() {
        throw new Error("llm down");
      },
    });
    const out = parse(await scanNotes({}, SETTINGS));
    expect(out.drafted).toBe(0);
    expect(out.failed).toBe(1);
  });

  test("missing creds → MISSING_CREDENTIALS", async () => {
    _setNotesStoreForTests(notesStore(["n-1"]));
    _setSubstackClientForTests(null);
    const res = await scanNotes({}, { invocationMetadata: { settings: {} } });
    expect(res.isError).toBe(true);
    expect((res as { code?: string }).code).toBe("MISSING_CREDENTIALS");
  });

  test("no targeted notes → drafts nothing, no error", async () => {
    _setNotesStoreForTests(notesStore([]));
    _setSubstackClientForTests(makeClient().client);
    const out = parse(await scanNotes({}, SETTINGS));
    expect(out.targeted).toBe(0);
    expect(out.drafted).toBe(0);
  });
});

// ── send_approved pacing for note-comment ───────────────────────

describe("send_approved — note-comment pacing", () => {
  async function seedApprovedNote(ref = "n-1") {
    _setNotesStoreForTests(notesStore([ref]));
    const { client, sent } = makeClient({ notes: { [ref]: { id: ref, author: "a", body: "x" } } });
    _setSubstackClientForTests(client);
    await scanNotes({}, SETTINGS);
    const id = (await list({ kind: "note-comment" }))[0]!.id;
    await approve(id);
    return { id, sent, client };
  }

  test("pacing-allowed → sent + pacing state recorded", async () => {
    const { id, sent } = await seedApprovedNote();
    // Generous pacing — high cap, no quiet hours, no interval.
    const out = parse(
      await sendApproved(
        { id },
        { invocationMetadata: { settings: { daily_note_cap: 100, min_send_interval_seconds: 0 } } },
      ),
    );
    expect(out.sent).toBe(1);
    expect(out.deferred).toBe(0);
    expect(sent).toHaveLength(1);
    expect((await get(id))?.status).toBe("sent");
    // Pacing state persisted with one send today.
    const ps = pacingKit.map.get("pacing-state") as { sentToday: number } | undefined;
    expect(ps?.sentToday).toBe(1);
  });

  test("pacing-blocked (cap 0) → DEFERRED, stays approved, NOT sent", async () => {
    const { id, sent } = await seedApprovedNote();
    const out = parse(
      await sendApproved(
        { id },
        { invocationMetadata: { settings: { daily_note_cap: 0 } } },
      ),
    );
    expect(out.sent).toBe(0);
    expect(out.deferred).toBe(1);
    expect(sent).toHaveLength(0); // never force-sent
    const item = await get(id);
    expect(item?.status).toBe("approved"); // left approved
    expect((item?.due_at ?? 0) > 0).toBe(true); // due_at pushed to deferUntil
  });

  test("cap exhaustion across two sends in one batch", async () => {
    // Two approved notes, cap 1 → first sends, second defers.
    _setNotesStoreForTests(notesStore(["n-1", "n-2"]));
    const { client, sent } = makeClient({
      notes: {
        "n-1": { id: "n-1", author: "a", body: "x" },
        "n-2": { id: "n-2", author: "b", body: "y" },
      },
    });
    _setSubstackClientForTests(client);
    await scanNotes({}, SETTINGS);
    for (const it of await list({ kind: "note-comment" })) await approve(it.id);

    const out = parse(
      await sendApproved(
        {},
        { invocationMetadata: { settings: { daily_note_cap: 1, min_send_interval_seconds: 0 } } },
      ),
    );
    expect(out.sent).toBe(1);
    expect(out.deferred).toBe(1);
    expect(sent).toHaveLength(1);

    const items = await list({ kind: "note-comment" });
    expect(items.filter((i) => i.status === "sent")).toHaveLength(1);
    expect(items.filter((i) => i.status === "approved")).toHaveLength(1); // deferred
  });

  test("min-interval defers a second note send within one batch", async () => {
    // Two approved notes, generous cap but a long min interval → first
    // sends, second defers on min-interval (the first send stamped
    // lastSentAt in the folded-forward pacing state).
    _setNotesStoreForTests(notesStore(["n-1", "n-2"]));
    const { client, sent } = makeClient({
      notes: {
        "n-1": { id: "n-1", author: "a", body: "x" },
        "n-2": { id: "n-2", author: "b", body: "y" },
      },
    });
    _setSubstackClientForTests(client);
    await scanNotes({}, SETTINGS);
    for (const it of await list({ kind: "note-comment" })) await approve(it.id);

    const out = parse(
      await sendApproved(
        {},
        {
          invocationMetadata: {
            settings: { daily_note_cap: 100, min_send_interval_seconds: 3600 },
          },
        },
      ),
    );
    expect(out.sent).toBe(1);
    expect(out.deferred).toBe(1);
    expect(sent).toHaveLength(1);
    const items = await list({ kind: "note-comment" });
    const deferredItem = items.find((i) => i.status === "approved");
    expect(deferredItem).toBeDefined();
    expect((deferredItem?.due_at ?? 0) > 0).toBe(true);
  });

  test("reply + welcome-dm are NOT pacing-gated (sent regardless of note cap)", async () => {
    // Seed an approved reply; even with note cap 0 it must send.
    const { client: c2, sent } = makeClient();
    // Use a comment scan to create a reply item.
    const replyClient: SubstackClient = {
      ...c2,
      async listOwnPostComments() {
        return [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }];
      },
    };
    _setSubstackClientForTests(replyClient);
    const { scanComments } = await import("../lib/tools");
    await scanComments({}, SETTINGS);
    const reply = (await list({ kind: "reply" }))[0]!;
    await approve(reply.id);

    const out = parse(
      await sendApproved(
        { id: reply.id },
        { invocationMetadata: { settings: { daily_note_cap: 0 } } },
      ),
    );
    expect(out.sent).toBe(1);
    expect(out.deferred).toBe(0);
    expect(sent.find((s) => s.ref === "c-1")).toBeUndefined(); // reply uses postCommentReply, not notes
    expect((await get(reply.id))?.status).toBe("sent");
  });
});
