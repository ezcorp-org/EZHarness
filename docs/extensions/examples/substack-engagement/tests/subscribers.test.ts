import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  scanSubscribers,
  runDueFollowups,
  resolveSequence,
  DEFAULT_FOLLOWUP_SEQUENCE,
  _setCursorStoreForTests,
  _setSequenceStoreForTests,
} from "../lib/subscribers";
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
  setDraftConfig,
} from "../lib/tools";
import {
  _setSubstackClientForTests,
  _resetSubstackClientForTests,
  type SubstackClient,
  type Subscriber,
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

function makeLlm(answer = "drafted"): DraftLlm {
  return {
    async complete() {
      return { content: answer };
    },
  };
}

function makeClient(opts: {
  pages?: Array<{ subscribers: Subscriber[]; cursor: string }>;
  listThrows?: Error;
} = {}) {
  const sent: Array<{ method: string; ref: string; body: string }> = [];
  let pageIdx = 0;
  const seenCursors: Array<string | null> = [];
  const client: SubstackClient = {
    async listOwnPostComments() {
      return [];
    },
    async postCommentReply({ commentId, body }) {
      sent.push({ method: "reply", ref: commentId, body });
      return { ok: true };
    },
    async listNewSubscribers(cursor) {
      if (opts.listThrows) throw opts.listThrows;
      seenCursors.push(cursor);
      const page = opts.pages?.[pageIdx] ?? { subscribers: [], cursor: cursor ?? "" };
      pageIdx++;
      return page;
    },
    async sendDirectMessage({ subscriberId, body }) {
      sent.push({ method: "dm", ref: subscriberId, body });
      return { ok: true };
    },
    async listNote(id) {
      return { id, author: "", body: "" };
    },
    async postNoteComment({ noteId, body }) {
      sent.push({ method: "note", ref: noteId, body });
      return { ok: true };
    },
  };
  return { client, sent, seenCursors };
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text);
}

let kit: ReturnType<typeof makeStore>;
let cursorKit: ReturnType<typeof makeStore>;
let counter = 0;
let nowMs = 1_000_000;

beforeEach(() => {
  kit = makeStore();
  cursorKit = makeStore();
  _setQueueStoreForTests(kit.store);
  _setCursorStoreForTests(cursorKit.store);
  _setSequenceStoreForTests(null); // default sequence unless overridden
  counter = 0;
  nowMs = 1_000_000;
  _setClockForTests(() => nowMs, () => `q-${counter++}`);
  _setLlmForTests(makeLlm());
  _setVoiceStoreForTests(null);
  setDraftConfig({ provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 256 });
});

afterEach(() => {
  _resetQueueForTests();
  _resetSubstackClientForTests();
  _setLlmForTests(null);
  _setVoiceStoreForTests(null);
  _setCursorStoreForTests(null);
  _setSequenceStoreForTests(null);
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

const SUBS: Subscriber[] = [
  { id: "s-1", name: "Ada", subscribedAt: 1 },
  { id: "s-2", name: "Bo", subscribedAt: 2 },
];

// ── resolveSequence ─────────────────────────────────────────────

describe("resolveSequence", () => {
  test("falls back to the built-in default when no store is bound", async () => {
    _setSequenceStoreForTests(null);
    expect(await resolveSequence()).toEqual(DEFAULT_FOLLOWUP_SEQUENCE);
  });

  test("falls back to default when the entity is absent", async () => {
    _setSequenceStoreForTests({
      async get() {
        return { value: null, exists: false };
      },
    });
    expect(await resolveSequence()).toEqual(DEFAULT_FOLLOWUP_SEQUENCE);
  });

  test("reads + converts offsetDays to ms from the entity", async () => {
    _setSequenceStoreForTests({
      async get<T>() {
        return {
          value: { steps: [{ offsetDays: 1, note: "n1" }, { offsetDays: 2 }] } as T,
          exists: true,
        };
      },
    });
    const seq = await resolveSequence();
    expect(seq).toHaveLength(2);
    expect(seq[0]?.offsetMs).toBe(24 * 60 * 60 * 1000);
    expect(seq[0]?.note).toBe("n1");
    expect(seq[1]?.offsetMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(seq[1]?.note).toBeUndefined();
  });

  test("drops invalid offsets + falls back to default when all dropped", async () => {
    _setSequenceStoreForTests({
      async get<T>() {
        return {
          value: { steps: [{ offsetDays: -1 }, { offsetDays: Number.NaN }, {}] } as T,
          exists: true,
        };
      },
    });
    expect(await resolveSequence()).toEqual(DEFAULT_FOLLOWUP_SEQUENCE);
  });
});

// ── scan_subscribers ────────────────────────────────────────────

describe("scan_subscribers", () => {
  test("enqueues a welcome (step 0, due now) + follow-up rows per new sub", async () => {
    const { client } = makeClient({ pages: [{ subscribers: SUBS, cursor: "cur-1" }] });
    _setSubstackClientForTests(client);

    const out = parse(await scanSubscribers({}, SETTINGS));
    expect(out.welcomed).toBe(2);
    expect(out.skipped).toBe(0);
    // 2 default follow-up steps × 2 subs = 4 follow-up rows.
    expect(out.followupsScheduled).toBe(4);
    expect(out.cursor).toBe("cur-1");

    const dms = await list({ kind: "welcome-dm" });
    expect(dms).toHaveLength(6); // 2 welcomes + 4 follow-ups

    const welcomes = dms.filter((d) => d.sequence_step === 0);
    expect(welcomes).toHaveLength(2);
    expect(welcomes.every((w) => w.due_at === nowMs)).toBe(true);
    expect(welcomes.every((w) => w.draft_body === "drafted")).toBe(true);

    const followups = dms.filter((d) => (d.sequence_step ?? 0) > 0);
    expect(followups).toHaveLength(4);
    // Follow-ups are undrafted (lazy) with a future due_at.
    expect(followups.every((f) => f.draft_body === "")).toBe(true);
    expect(followups.every((f) => (f.due_at ?? 0) > nowMs)).toBe(true);
  });

  test("advances the cursor + a duplicate sub is not re-welcomed", async () => {
    const { client, seenCursors } = makeClient({
      pages: [
        { subscribers: [SUBS[0]!], cursor: "cur-1" },
        { subscribers: SUBS, cursor: "cur-2" }, // s-1 repeats
      ],
    });
    _setSubstackClientForTests(client);

    const first = parse(await scanSubscribers({}, SETTINGS));
    expect(first.welcomed).toBe(1);
    expect(seenCursors[0]).toBeNull(); // first poll starts with no cursor

    const second = parse(await scanSubscribers({}, SETTINGS));
    expect(seenCursors[1]).toBe("cur-1"); // cursor persisted + reused
    expect(second.welcomed).toBe(1); // only s-2 is new
    expect(second.skipped).toBe(1); // s-1 deduped

    expect((await list({ kind: "welcome-dm" })).filter((d) => d.sequence_step === 0)).toHaveLength(2);
  });

  test("missing creds → MISSING_CREDENTIALS", async () => {
    _setSubstackClientForTests(null);
    const res = await scanSubscribers({}, { invocationMetadata: { settings: {} } });
    expect(res.isError).toBe(true);
    expect((res as { code?: string }).code).toBe("MISSING_CREDENTIALS");
  });

  test("client list error → CLIENT_ERROR", async () => {
    const { client } = makeClient({ listThrows: new Error("boom") });
    _setSubstackClientForTests(client);
    const res = await scanSubscribers({}, SETTINGS);
    expect((res as { code?: string }).code).toBe("CLIENT_ERROR");
  });

  test("welcome draft failure is reported per-sub without aborting", async () => {
    const { client } = makeClient({ pages: [{ subscribers: SUBS, cursor: "c" }] });
    _setSubstackClientForTests(client);
    _setLlmForTests({
      async complete() {
        throw new Error("llm down");
      },
    });
    const out = parse(await scanSubscribers({}, SETTINGS));
    expect(out.welcomed).toBe(0);
    expect(out.failed).toBe(2);
    // No follow-ups scheduled for subs whose welcome failed.
    expect(out.followupsScheduled).toBe(0);
  });

  test("custom sequence from the entity controls follow-up offsets", async () => {
    const { client } = makeClient({ pages: [{ subscribers: [SUBS[0]!], cursor: "c" }] });
    _setSubstackClientForTests(client);
    _setSequenceStoreForTests({
      async get<T>() {
        return { value: { steps: [{ offsetDays: 5 }] } as T, exists: true };
      },
    });
    const out = parse(await scanSubscribers({}, SETTINGS));
    expect(out.followupsScheduled).toBe(1);
    const followup = (await list({ kind: "welcome-dm" })).find(
      (d) => (d.sequence_step ?? 0) > 0,
    );
    expect(followup?.due_at).toBe(nowMs + 5 * 24 * 60 * 60 * 1000);
  });
});

// ── runDueFollowups (lazy drafting) ─────────────────────────────

describe("runDueFollowups", () => {
  async function seedSubscribers() {
    const { client } = makeClient({ pages: [{ subscribers: [SUBS[0]!], cursor: "c" }] });
    _setSubstackClientForTests(client);
    await scanSubscribers({}, SETTINGS);
  }

  test("drafts due, undrafted, pending follow-up rows; skips not-yet-due", async () => {
    await seedSubscribers();
    const before = await list({ kind: "welcome-dm" });
    const followups = before.filter((d) => (d.sequence_step ?? 0) > 0);
    expect(followups.every((f) => f.draft_body === "")).toBe(true);

    // Advance time past the FIRST follow-up (3 days) but not the second (7).
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const res = await runDueFollowups(nowMs + threeDays + 1);
    expect(res.drafted).toBe(1); // only the 3-day step is due
    expect(res.failed).toBe(0);

    const after = await list({ kind: "welcome-dm" });
    const drafted = after.filter((d) => (d.sequence_step ?? 0) > 0 && d.draft_body !== "");
    expect(drafted).toHaveLength(1);
    expect(drafted[0]?.draft_body).toBe("drafted");
  });

  test("re-running does not re-draft already-drafted rows", async () => {
    await seedSubscribers();
    const farFuture = nowMs + 30 * 24 * 60 * 60 * 1000;
    const first = await runDueFollowups(farFuture);
    expect(first.drafted).toBe(2); // both steps due
    const second = await runDueFollowups(farFuture);
    expect(second.drafted).toBe(0); // nothing left undrafted
  });

  test("the welcome row (step 0) is already drafted and never re-touched", async () => {
    await seedSubscribers();
    const farFuture = nowMs + 30 * 24 * 60 * 60 * 1000;
    await runDueFollowups(farFuture);
    const welcome = (await list({ kind: "welcome-dm" })).find((d) => d.sequence_step === 0);
    expect(welcome?.draft_body).toBe("drafted"); // unchanged from scan time
  });

  test("a lazy-draft failure increments failed without crashing", async () => {
    await seedSubscribers();
    _setLlmForTests({
      async complete() {
        throw new Error("llm down");
      },
    });
    const res = await runDueFollowups(nowMs + 30 * 24 * 60 * 60 * 1000);
    expect(res.drafted).toBe(0);
    expect(res.failed).toBe(2);
  });
});

// ── send_approved routes welcome-dm to sendDirectMessage ────────

describe("send_approved for welcome-dm", () => {
  test("routes an approved welcome-dm to client.sendDirectMessage", async () => {
    const { client, sent } = makeClient({ pages: [{ subscribers: [SUBS[0]!], cursor: "c" }] });
    _setSubstackClientForTests(client);
    await scanSubscribers({}, SETTINGS);
    const welcome = (await list({ kind: "welcome-dm" })).find((d) => d.sequence_step === 0)!;
    await approve(welcome.id);

    const out = parse(await sendApproved({ id: welcome.id }, SETTINGS));
    expect(out.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("dm");
    expect(sent[0]?.ref).toBe("s-1");
    expect((await get(welcome.id))?.status).toBe("sent");
  });

  test("a DM send failure marks the welcome-dm failed", async () => {
    const base = makeClient({ pages: [{ subscribers: [SUBS[0]!], cursor: "c" }] });
    _setSubstackClientForTests(base.client);
    await scanSubscribers({}, SETTINGS);
    const welcome = (await list({ kind: "welcome-dm" })).find((d) => d.sequence_step === 0)!;
    await approve(welcome.id);

    // Swap in a client whose DM fails.
    const failing: SubstackClient = {
      ...base.client,
      async sendDirectMessage() {
        return { ok: false, error: "DM blocked" };
      },
    };
    _setSubstackClientForTests(failing);

    const out = parse(await sendApproved({ id: welcome.id }, SETTINGS));
    expect(out.failed).toBe(1);
    expect((await get(welcome.id))?.error).toContain("DM blocked");
  });
});
