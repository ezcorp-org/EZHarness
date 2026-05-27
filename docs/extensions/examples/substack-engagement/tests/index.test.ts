// ── index — cron handler (runScheduledScan) + safe() wrapper ────
//
// The `*/15 * * * *` cron is a first-class deliverable: it drafts only
// and MUST NEVER send (locked decision #1 — an ownerless fire has no
// human in the loop to approve). These tests drive `runScheduledScan`
// through the same injectable seams the production wiring uses (fake
// SubstackClient + LLM + in-memory stores), assert the no-send
// invariant across all four scan branches, and prove `safe()` swallows
// a throw from one scan so the others still run.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runScheduledScan } from "../index";
import {
  _setLlmForTests,
  _setVoiceStoreForTests,
  _setPacingStoreForTests,
  setDraftConfig,
} from "../lib/tools";
import {
  list,
  _setQueueStoreForTests,
  _setClockForTests,
  _resetQueueForTests,
  type QueueStoreLike,
} from "../lib/review-queue";
import {
  _setSubstackClientForTests,
  _resetSubstackClientForTests,
  type SubstackClient,
  type Comment,
  type Subscriber,
} from "../lib/substack-client";
import {
  _setCursorStoreForTests,
  _setSequenceStoreForTests,
} from "../lib/subscribers";
import { _setNotesStoreForTests } from "../lib/notes";
import type { DraftLlm } from "../lib/voice";

// ── In-memory store (shared shape across every test file) ───────

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

function makeLlm(answer = "drafted body"): DraftLlm {
  return {
    async complete() {
      return { content: answer };
    },
  };
}

// A client that RECORDS every method call. The send methods
// (postCommentReply / sendDirectMessage / postNoteComment) push onto
// `sends` — if the cron ever calls one, the no-send invariant fails.
interface RecordingClientOpts {
  comments?: Comment[];
  subscribers?: Subscriber[];
  notes?: Record<string, { author: string; body: string }>;
  listCommentsThrows?: Error;
}

function makeRecordingClient(opts: RecordingClientOpts = {}) {
  const reads: string[] = [];
  const sends: Array<{ method: string; ref: string }> = [];
  const client: SubstackClient = {
    async listOwnPostComments() {
      reads.push("listOwnPostComments");
      if (opts.listCommentsThrows) throw opts.listCommentsThrows;
      return opts.comments ?? [];
    },
    async postCommentReply({ commentId }) {
      sends.push({ method: "postCommentReply", ref: commentId });
      return { ok: true, id: "x" };
    },
    async listNewSubscribers(cursor) {
      reads.push("listNewSubscribers");
      return { subscribers: opts.subscribers ?? [], cursor: cursor ?? "cur-1" };
    },
    async sendDirectMessage({ subscriberId }) {
      sends.push({ method: "sendDirectMessage", ref: subscriberId });
      return { ok: true };
    },
    async listNote(id) {
      reads.push("listNote");
      const n = opts.notes?.[id];
      return { id, author: n?.author ?? "", body: n?.body ?? "" };
    },
    async postNoteComment({ noteId }) {
      sends.push({ method: "postNoteComment", ref: noteId });
      return { ok: true };
    },
  };
  return { client, reads, sends };
}

// Settings carrying valid creds so resolveClient short-circuits to the
// injected fake (it returns the test client before reading creds, but we
// keep them realistic).
let queueKit: ReturnType<typeof makeStore>;
let counter = 0;

beforeEach(() => {
  queueKit = makeStore();
  _setQueueStoreForTests(queueKit.store);
  counter = 0;
  _setClockForTests(() => 1_000, () => `q-${counter++}`);
  _setLlmForTests(makeLlm());
  _setVoiceStoreForTests(null);
  _setPacingStoreForTests(makeStore().store);
  _setCursorStoreForTests(makeStore().store);
  _setSequenceStoreForTests(null); // built-in default follow-up sequence
  _setNotesStoreForTests(null); // no targeted notes by default
  setDraftConfig({ provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 512 });
});

afterEach(() => {
  _resetQueueForTests();
  _resetSubstackClientForTests();
  _setLlmForTests(null);
  _setVoiceStoreForTests(null);
  _setPacingStoreForTests(null as never);
  _setCursorStoreForTests(null);
  _setSequenceStoreForTests(null);
  _setNotesStoreForTests(null);
});

describe("runScheduledScan — drafts only, NEVER sends (locked decision #1)", () => {
  test("dispatches all four scan branches and calls no client send", async () => {
    // Seed work for every branch: a comment, a new subscriber, and a
    // targeted note (the follow-up branch runs against the queue).
    const { client, reads, sends } = makeRecordingClient({
      comments: [{ id: "c-1", postId: "p-1", author: "alice", body: "great read", createdAt: 1 }],
      subscribers: [{ id: "s-1", name: "Ada", subscribedAt: 1 }],
      notes: { "n-1": { author: "carol", body: "interesting note" } },
    });
    _setSubstackClientForTests(client);
    // Give scan_notes a targeted ref so it actually fetches + drafts.
    _setNotesStoreForTests({
      async get<T>() {
        return { value: { noteRefs: ["n-1"] } as T, exists: true };
      },
    });

    await runScheduledScan();

    // All three read surfaces were exercised (comment scan, subscriber
    // poll, note fetch) — the cron did real drafting work.
    expect(reads).toContain("listOwnPostComments");
    expect(reads).toContain("listNewSubscribers");
    expect(reads).toContain("listNote");

    // THE INVARIANT: not one send method fired.
    expect(sends).toHaveLength(0);

    // And the work landed as PENDING drafts in the queue (never sent).
    const queued = await list();
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((i) => i.status === "pending")).toBe(true);
    // A reply, a welcome-dm, and a note-comment were all drafted.
    const kinds = new Set(queued.map((i) => i.kind));
    expect(kinds.has("reply")).toBe(true);
    expect(kinds.has("welcome-dm")).toBe(true);
    expect(kinds.has("note-comment")).toBe(true);
  });

  test("does not throw when there is nothing to scan", async () => {
    const { client, sends } = makeRecordingClient();
    _setSubstackClientForTests(client);
    expect(await runScheduledScan()).toBeUndefined();
    expect(sends).toHaveLength(0);
    expect(await list()).toHaveLength(0);
  });
});

describe("safe() — one failing scan never aborts the others", () => {
  test("a throw in scan_comments is swallowed; later scans still run", async () => {
    // scan_comments throws (client.listOwnPostComments blows up), but the
    // subscriber poll must still enqueue a welcome DM.
    const { client, reads, sends } = makeRecordingClient({
      listCommentsThrows: new Error("boom — comment listing failed"),
      subscribers: [{ id: "s-9", name: "Grace", subscribedAt: 2 }],
    });
    _setSubstackClientForTests(client);

    // Must NOT throw — safe() swallows the scan_comments failure.
    expect(await runScheduledScan()).toBeUndefined();

    // The failing branch was attempted...
    expect(reads).toContain("listOwnPostComments");
    // ...and the LATER branch still ran (subscriber poll happened).
    expect(reads).toContain("listNewSubscribers");

    // The welcome DM was drafted as a pending row despite the earlier throw.
    const welcomes = await list({ kind: "welcome-dm" });
    expect(welcomes.some((i) => i.target_ref === "s-9" && i.status === "pending")).toBe(true);

    // Still no send (failure path must not auto-send either).
    expect(sends).toHaveLength(0);
  });
});
