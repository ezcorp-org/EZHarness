import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  scanComments,
  listQueue,
  approveItem,
  rejectItem,
  editItem,
  sendApproved,
  openReviewQueue,
  readVoiceProfile,
  _setLlmForTests,
  _setVoiceStoreForTests,
  setDraftConfig,
} from "../lib/tools";
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
  _setSubstackClientForTests,
  _resetSubstackClientForTests,
  type SubstackClient,
  type Comment,
  type SendResult,
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

function makeLlm(answer = "drafted body"): DraftLlm {
  return {
    async complete() {
      return { content: answer };
    },
  };
}

interface FakeClientOpts {
  comments?: Comment[];
  listThrows?: Error;
  reply?: (body: string) => SendResult;
}

function makeClient(opts: FakeClientOpts = {}) {
  const sent: Array<{ method: string; body: string; ref: string }> = [];
  const client: SubstackClient = {
    async listOwnPostComments() {
      if (opts.listThrows) throw opts.listThrows;
      return opts.comments ?? [];
    },
    async postCommentReply({ body, commentId }) {
      sent.push({ method: "reply", body, ref: commentId });
      return opts.reply ? opts.reply(body) : { ok: true, id: "posted-1" };
    },
    async listNewSubscribers(cursor) {
      return { subscribers: [], cursor: cursor ?? "" };
    },
    async sendDirectMessage({ body, subscriberId }) {
      sent.push({ method: "dm", body, ref: subscriberId });
      return { ok: true };
    },
    async listNote(id) {
      return { id, author: "", body: "" };
    },
    async postNoteComment({ body, noteId }) {
      sent.push({ method: "note", body, ref: noteId });
      return { ok: true };
    },
  };
  return { client, sent };
}

function text(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text;
}
function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(text(res));
}

let kit: ReturnType<typeof makeStore>;
let counter = 0;

beforeEach(() => {
  kit = makeStore();
  _setQueueStoreForTests(kit.store);
  counter = 0;
  _setClockForTests(() => 1_000, () => `q-${counter++}`);
  _setLlmForTests(makeLlm());
  _setVoiceStoreForTests(null); // no voice profile by default
  setDraftConfig({ provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 512 });
});

afterEach(() => {
  _resetQueueForTests();
  _resetSubstackClientForTests();
  _setLlmForTests(null);
  _setVoiceStoreForTests(null);
});

const SETTINGS = {
  invocationMetadata: {
    settings: {
      substack_publication_url: "https://me.substack.com",
      substack_session_token: "tok",
      substack_user_id: "42",
    },
  },
};

// ── scan_comments ───────────────────────────────────────────────

describe("scan_comments", () => {
  const comments: Comment[] = [
    { id: "c-1", postId: "p-1", author: "alice", body: "great read", createdAt: 1 },
    { id: "c-2", postId: "p-1", author: "bob", body: "disagree", createdAt: 2 },
  ];

  test("drafts a pending reply per new comment", async () => {
    const { client } = makeClient({ comments });
    _setSubstackClientForTests(client);

    const res = await scanComments({}, SETTINGS);
    const out = parse(res);
    expect(res.isError).toBe(false);
    expect(out.drafted).toBe(2);
    expect(out.skipped).toBe(0);

    const queued = await list({ kind: "reply" });
    expect(queued).toHaveLength(2);
    expect(queued.every((i) => i.status === "pending")).toBe(true);
    expect(queued.map((i) => i.target_ref).sort()).toEqual(["c-1", "c-2"]);
    expect(queued[0]?.draft_body).toBe("drafted body");
    expect(queued[0]?.context).toBe("great read");
  });

  test("does not double-queue an already-queued comment (dedupe on target_ref)", async () => {
    const { client } = makeClient({ comments });
    _setSubstackClientForTests(client);

    await scanComments({}, SETTINGS);
    const second = parse(await scanComments({}, SETTINGS));
    expect(second.drafted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(await list({ kind: "reply" })).toHaveLength(2); // no growth
  });

  test("missing credentials → MISSING_CREDENTIALS, no drafts", async () => {
    _setSubstackClientForTests(null); // force the production cred path
    const res = await scanComments({}, { invocationMetadata: { settings: {} } });
    expect(res.isError).toBe(true);
    expect((res as { code?: string }).code).toBe("MISSING_CREDENTIALS");
    expect(await list()).toHaveLength(0);
  });

  test("client list error surfaced as CLIENT_ERROR", async () => {
    const { client } = makeClient({ listThrows: new Error("429 rate limited") });
    _setSubstackClientForTests(client);
    const res = await scanComments({}, SETTINGS);
    expect(res.isError).toBe(true);
    expect((res as { code?: string }).code).toBe("CLIENT_ERROR");
    expect(text(res)).toContain("429 rate limited");
  });

  test("per-comment draft failure is reported but does not abort the scan", async () => {
    const { client } = makeClient({ comments });
    _setSubstackClientForTests(client);
    // LLM throws → draftReply returns ok:false for every comment.
    _setLlmForTests({
      async complete() {
        throw new Error("llm down");
      },
    });
    const out = parse(await scanComments({}, SETTINGS));
    expect(out.drafted).toBe(0);
    expect(out.failed).toBe(2);
    expect(Array.isArray(out.failures)).toBe(true);
  });

  test("forwards the limit arg to the client", async () => {
    let seenLimit: number | undefined;
    const client: SubstackClient = {
      ...makeClient().client,
      async listOwnPostComments(o) {
        seenLimit = o.limit;
        return [];
      },
    };
    _setSubstackClientForTests(client);
    await scanComments({ limit: 5 }, SETTINGS);
    expect(seenLimit).toBe(5);
  });
});

// ── list_queue ──────────────────────────────────────────────────

describe("list_queue", () => {
  test("lists all + filters by status/kind", async () => {
    const { client } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);

    const all = parse(await listQueue({}));
    expect(all.count).toBe(1);

    const pending = parse(await listQueue({ status: "pending" }));
    expect(pending.count).toBe(1);

    const approved = parse(await listQueue({ status: "approved" }));
    expect(approved.count).toBe(0);
  });

  test("returns an empty queue (not an error) when the store read throws", async () => {
    // Mirrors the `ezcorp ext verify` smoke harness, which wires no
    // storage handler — list_queue must degrade to an empty result.
    _setQueueStoreForTests({
      async get() {
        throw new Error("no storage handler wired");
      },
      async set() {
        return {};
      },
      async delete() {
        return {};
      },
    });
    const out = parse(await listQueue({}));
    expect(out.count).toBe(0);
    expect(out.ok).toBe(true);
  });
});

// ── approve / reject / edit ─────────────────────────────────────

describe("approve_item / reject_item / edit_item", () => {
  async function seedOne() {
    const { client } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    const items = await list();
    return items[0]!.id;
  }

  test("approve flips status to approved", async () => {
    const id = await seedOne();
    const out = parse(await approveItem({ id }));
    expect((out.item as { status: string }).status).toBe("approved");
  });

  test("reject flips status to rejected", async () => {
    const id = await seedOne();
    const out = parse(await rejectItem({ id }));
    expect((out.item as { status: string }).status).toBe("rejected");
  });

  test("edit mutates draft_body", async () => {
    const id = await seedOne();
    const out = parse(await editItem({ id, draft_body: "my edit" }));
    expect((out.item as { draft_body: string }).draft_body).toBe("my edit");
  });

  test("invalid id → NOT_FOUND for each", async () => {
    for (const fn of [approveItem, rejectItem]) {
      const res = await fn({ id: "ghost" });
      expect(res.isError).toBe(true);
      expect((res as { code?: string }).code).toBe("NOT_FOUND");
    }
    const editRes = await editItem({ id: "ghost", draft_body: "x" });
    expect((editRes as { code?: string }).code).toBe("NOT_FOUND");
  });

  test("missing / bad args rejected", async () => {
    expect((await approveItem({})).isError).toBe(true);
    expect((await rejectItem({})).isError).toBe(true);
    expect((await editItem({ id: "x" })).isError).toBe(true); // no body
    expect((await editItem({ id: "x", draft_body: "   " })).isError).toBe(true); // blank body
  });
});

// ── send_approved ───────────────────────────────────────────────

describe("send_approved", () => {
  async function seedApprovedReply() {
    const { client, sent } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    const id = (await list())[0]!.id;
    await approve(id);
    return { id, sent };
  }

  test("sends only approved items; pending + rejected are skipped", async () => {
    // Three items: one approved, one pending, one rejected.
    const { client, sent } = makeClient({
      comments: [
        { id: "c-1", postId: "p", author: "a", body: "1", createdAt: 0 },
        { id: "c-2", postId: "p", author: "b", body: "2", createdAt: 0 },
        { id: "c-3", postId: "p", author: "c", body: "3", createdAt: 0 },
      ],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    const items = await list();
    await approve(items[0]!.id);
    await rejectItem({ id: items[2]!.id });

    const out = parse(await sendApproved({}, SETTINGS));
    expect(out.sent).toBe(1);
    expect(out.failed).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ref).toBe("c-1");

    // Only the approved item flipped to sent.
    expect((await get(items[0]!.id))?.status).toBe("sent");
    expect((await get(items[1]!.id))?.status).toBe("pending");
    expect((await get(items[2]!.id))?.status).toBe("rejected");
  });

  test("client failure → item marked failed with the error", async () => {
    const { client } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
      reply: () => ({ ok: false, error: "401 expired token" }),
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    const id = (await list())[0]!.id;
    await approve(id);

    const out = parse(await sendApproved({}, SETTINGS));
    expect(out.failed).toBe(1);
    const item = await get(id);
    expect(item?.status).toBe("failed");
    expect(item?.error).toContain("401 expired token");
  });

  test("a thrown client error is caught and marks the item failed", async () => {
    const id = (await seedApprovedReply()).id;
    const throwing: SubstackClient = {
      ...makeClient().client,
      async postCommentReply() {
        throw new Error("socket hangup");
      },
    };
    _setSubstackClientForTests(throwing);
    const out = parse(await sendApproved({}, SETTINGS));
    expect(out.failed).toBe(1);
    expect((await get(id))?.error).toContain("socket hangup");
  });

  test("REFUSES a specific non-approved item with NOT_APPROVED", async () => {
    const { client } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS); // item is pending, not approved
    const id = (await list())[0]!.id;

    const res = await sendApproved({ id }, SETTINGS);
    expect(res.isError).toBe(true);
    expect((res as { code?: string }).code).toBe("NOT_APPROVED");
    expect((await get(id))?.status).toBe("pending"); // untouched
  });

  test("send_approved with id targets only that approved item", async () => {
    const { id, sent } = await seedApprovedReply();
    const out = parse(await sendApproved({ id }, SETTINGS));
    expect(out.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });

  test("missing creds → MISSING_CREDENTIALS", async () => {
    _setSubstackClientForTests(null);
    const res = await sendApproved({}, { invocationMetadata: { settings: {} } });
    expect((res as { code?: string }).code).toBe("MISSING_CREDENTIALS");
  });

  test("send_approved with unknown id → NOT_FOUND", async () => {
    _setSubstackClientForTests(makeClient().client);
    const res = await sendApproved({ id: "ghost" }, SETTINGS);
    expect((res as { code?: string }).code).toBe("NOT_FOUND");
  });
});

// ── open_review_queue ───────────────────────────────────────────

describe("open_review_queue", () => {
  test("returns a substack-review card with pending + approved buckets", async () => {
    const { client } = makeClient({
      comments: [
        { id: "c-1", postId: "p", author: "a", body: "1", createdAt: 0 },
        { id: "c-2", postId: "p", author: "b", body: "2", createdAt: 0 },
      ],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    const items = await list();
    await approve(items[0]!.id);

    const res = await openReviewQueue();
    expect((res as { cardType?: string }).cardType).toBe("substack-review");
    const payload = parse(res);
    expect(payload.cardType).toBe("substack-review");
    expect((payload.counts as { pending: number }).pending).toBe(1);
    expect((payload.counts as { approved: number }).approved).toBe(1);
  });
});

// ── voice-profile reader ────────────────────────────────────────

describe("readVoiceProfile", () => {
  test("returns null when no voice store is bound", async () => {
    _setVoiceStoreForTests(null);
    expect(await readVoiceProfile()).toBeNull();
  });

  test("reads the default voice-profile entity when present", async () => {
    _setVoiceStoreForTests({
      async get<T>(key: string) {
        if (key === "__entity:voice-profile:default") {
          return {
            value: { name: "Me", voiceDescription: "warm" } as T,
            exists: true,
          };
        }
        return { value: null, exists: false };
      },
    });
    const profile = await readVoiceProfile();
    expect(profile?.voiceDescription).toBe("warm");
  });

  test("returns null when the entity is absent in the store", async () => {
    _setVoiceStoreForTests({
      async get() {
        return { value: null, exists: false };
      },
    });
    expect(await readVoiceProfile()).toBeNull();
  });

  test("voice profile description is threaded into the draft system prompt", async () => {
    // When a profile with a voiceDescription exists, the LLM systemPrompt
    // is the description (not the agent-prompt floor).
    let seenSystem: string | undefined;
    _setLlmForTests({
      async complete(args) {
        seenSystem = args.systemPrompt;
        return { content: "ok" };
      },
    });
    _setVoiceStoreForTests({
      async get<T>() {
        return { value: { name: "Me", voiceDescription: "be playful" } as T, exists: true };
      },
    });
    const { client } = makeClient({
      comments: [{ id: "c-1", postId: "p", author: "a", body: "hi", createdAt: 0 }],
    });
    _setSubstackClientForTests(client);
    await scanComments({}, SETTINGS);
    expect(seenSystem).toBe("be playful");
  });
});
