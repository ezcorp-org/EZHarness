/**
 * Phase 48 Wave 1 — API guards around the Ez mode lock.
 *
 *  PUT  /api/conversations/[id]
 *    - rejects modeId mutation on conversations where kind === 'ez' (403)
 *    - leaves regular conversations unaffected (modeId is mutable on them)
 *    - non-modeId fields (e.g. title) on an ez conversation pass through
 *
 *  POST /api/conversations
 *    - rejects creating a new (regular) conversation with modeId pointing
 *      at the seeded Ez mode (slug='ez') with 403
 *    - accepts a regular modeId for a non-Ez mode
 *    - returns 404 when modeId points at a non-existent mode
 *
 * DB query modules are mocked at the import boundary so the test stays
 * off PGlite. Mirror of existing api-conversations.server.test.ts +
 * api-conversations-id-rename.server.test.ts patterns.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  updateConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listConversations: vi.fn(),
  searchConversations: vi.fn(),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig: vi.fn(),
}));

vi.mock("$server/db/queries/modes", () => ({
  getMode: vi.fn(),
}));

vi.mock("$server/db/queries/projects", () => ({
  getProject: vi.fn(),
}));

vi.mock("$server/chat/attachments/storage", () => ({
  deleteForConversation: vi.fn(),
}));

const { getConversation, createConversation, updateConversation } = await import(
  "$server/db/queries/conversations"
);
const { getMode } = await import("$server/db/queries/modes");

const { POST } = await import("../routes/api/conversations/+server");
const { PUT } = await import("../routes/api/conversations/[id]/+server");

function makePostEvent(opts: {
  body?: unknown;
  locals?: Record<string, unknown>;
}) {
  return {
    url: new URL("http://localhost/api/conversations"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

function makePutEvent(opts: {
  id?: string;
  body?: unknown;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "c1";
  const href = `http://localhost/api/conversations/${id}`;
  return {
    url: new URL(href),
    params: { id },
    locals: opts.locals ?? {},
    request: new Request(href, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
// Pretend-UUID for a non-Ez custom mode the user owns.
const REGULAR_MODE_ID = "00000000-0000-4000-8000-00000000aaaa";

describe("PUT /api/conversations/[id] — Ez mode lock", () => {
  beforeEach(() => {
    vi.mocked(getConversation).mockReset();
    vi.mocked(updateConversation).mockReset();
  });

  test("rejects 403 when client tries to change modeId on an Ez conversation", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "ez-conv",
      userId: user.id,
      kind: "ez",
      modeId: "builtin-ez",
      title: "Ez",
    } as any);
    const res = await PUT(
      makePutEvent({
        id: "ez-conv",
        locals: { user },
        body: { modeId: REGULAR_MODE_ID },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Ez/i);
    // The mutation must NOT propagate to the DB layer.
    expect(vi.mocked(updateConversation)).not.toHaveBeenCalled();
  });

  test("rejects modeId=null nullification on an Ez conversation (still a modeId mutation)", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "ez-conv",
      userId: user.id,
      kind: "ez",
      modeId: "builtin-ez",
    } as any);
    const res = await PUT(
      makePutEvent({
        id: "ez-conv",
        locals: { user },
        body: { modeId: null },
      }),
    );
    expect(res.status).toBe(403);
    expect(vi.mocked(updateConversation)).not.toHaveBeenCalled();
  });

  test("non-modeId fields on an Ez conversation pass through (e.g. title)", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "ez-conv",
      userId: user.id,
      kind: "ez",
      modeId: "builtin-ez",
      title: "Ez",
    } as any);
    vi.mocked(updateConversation).mockResolvedValue({
      id: "ez-conv",
      userId: user.id,
      kind: "ez",
      modeId: "builtin-ez",
      title: "Renamed",
    } as any);
    const res = await PUT(
      makePutEvent({
        id: "ez-conv",
        locals: { user },
        body: { title: "Renamed" },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(updateConversation)).toHaveBeenCalledTimes(1);
  });

  test("regular conversation: modeId mutation is allowed (the lock only fires on kind='ez')", async () => {
    vi.mocked(getConversation).mockResolvedValue({
      id: "regular-conv",
      userId: user.id,
      kind: "regular",
      modeId: null,
    } as any);
    vi.mocked(updateConversation).mockResolvedValue({
      id: "regular-conv",
      userId: user.id,
      kind: "regular",
      modeId: REGULAR_MODE_ID,
    } as any);
    const res = await PUT(
      makePutEvent({
        id: "regular-conv",
        locals: { user },
        body: { modeId: REGULAR_MODE_ID },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(updateConversation)).toHaveBeenCalledWith("regular-conv", {
      modeId: REGULAR_MODE_ID,
    });
  });
});

describe("POST /api/conversations — Ez mode reservation", () => {
  beforeEach(() => {
    vi.mocked(createConversation).mockReset();
    vi.mocked(getMode).mockReset();
  });

  test("rejects 403 when modeId points at the seeded Ez mode (slug='ez')", async () => {
    vi.mocked(getMode).mockResolvedValue({
      id: "builtin-ez",
      slug: "ez",
      name: "Ez",
      builtin: true,
      toolRestriction: "allowlist",
      allowedTools: ["fill_form", "navigate_to"],
    } as any);
    const res = await POST(
      makePostEvent({
        body: { projectId: PROJECT_ID, modeId: "builtin-ez" },
        locals: { user },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/ez/i);
    // Must not touch the DB-write layer.
    expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
  });

  test("returns 404 when modeId references a non-existent mode", async () => {
    vi.mocked(getMode).mockResolvedValue(undefined as any);
    const res = await POST(
      makePostEvent({
        body: { projectId: PROJECT_ID, modeId: "ghost-mode-id" },
        locals: { user },
      }),
    );
    expect(res.status).toBe(404);
    expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
  });

  test("happy path: a regular (non-Ez) modeId is accepted", async () => {
    vi.mocked(getMode).mockResolvedValue({
      id: REGULAR_MODE_ID,
      slug: "plan",
      name: "Plan",
      builtin: true,
      toolRestriction: "read-only",
      allowedTools: null,
    } as any);
    vi.mocked(createConversation).mockResolvedValue({
      id: "c-new",
      kind: "regular",
    } as any);
    const res = await POST(
      makePostEvent({
        body: { projectId: PROJECT_ID, modeId: REGULAR_MODE_ID },
        locals: { user },
      }),
    );
    expect(res.status).toBe(201);
    expect(vi.mocked(createConversation)).toHaveBeenCalledTimes(1);
  });

  test("when modeId is omitted entirely, the lookup is skipped (no getMode call)", async () => {
    vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);
    await POST(
      makePostEvent({
        body: { projectId: PROJECT_ID },
        locals: { user },
      }),
    );
    expect(vi.mocked(getMode)).not.toHaveBeenCalled();
    expect(vi.mocked(createConversation)).toHaveBeenCalledTimes(1);
  });
});
