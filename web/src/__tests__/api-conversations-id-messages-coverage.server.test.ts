/**
 * Branch-coverage backfill for
 * `web/src/routes/api/conversations/[id]/messages/+server.ts`.
 *
 * Two sibling vitest files already cover the route's happy paths and
 * the `/goal` interceptor:
 *
 *   - api-conversations-id-messages.server.test.ts — GET/POST auth +
 *     ownership + token-budget + parentMessageId resolution.
 *   - api-conversations-id-messages-goal.server.test.ts — the
 *     slash-prefix interceptor (I1b/I12/I13 + I5b/I5d + disabled-card
 *     fallback).
 *
 * This file fills the remaining branches the v8 coverage report
 * (`bunx vitest run --coverage`) listed as zero-hit for the route:
 *
 *   GET handler
 *     - `?all=true` — returns every message in the conversation.
 *     - `?leafMessageId=` — returns the explicit-leaf walk.
 *     - `?withToolCalls=true` — returns the tool-call decorated payload
 *       plus the sub-conversation tool-call rollup.
 *     - happy path with a leaf — returns the latest-leaf walk.
 *
 *   POST handler
 *     - multipart parse error (empty content) — 400.
 *     - multipart happy path with content + zero files — exercises
 *       `parseMultipart` body assembly without spilling into the
 *       attachment block.
 *     - attachments-without-provider/model — 400.
 *     - attachments file count over `caps.maxFilesPerMessage` — 400.
 *     - attachments project.path missing — 500.
 *     - attachment validator rejects a file (`TOO_LARGE` → 413) —
 *       hits the per-file validation early-return.
 *     - attachment persistence throws → 500 with disk + DB rollback.
 *     - EZ action handler — registry hit, handler resolves → persisted
 *       result row + LLM call continues (mixed message).
 *     - EZ action handler throws → error card + persisted row.
 *     - EZ action-only message → `streamChat` NOT invoked, runId:null.
 *     - Unknown EZ action → silent strip (no persisted row, no error).
 *     - `streamChat` rejection — the `streamPromise.catch` handler runs
 *       without crashing the response.
 *
 * Mock strategy mirrors the sibling files so the harness stays
 * recognisable: every persistence + runtime dependency is stubbed via
 * `vi.mock`; the handler is imported AFTER the mocks so module-load
 * resolution sees the stubs. All tests run against a top-level
 * conversation (root === self) — the parent-walk path is exercised
 * separately by `messages-ownership-*.test.ts` (bun:test).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── Mock surface ────────────────────────────────────────────────────

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const getMessages = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getSubConversationToolCalls = vi.fn();
const createMessage = vi.fn();
const insertAttachment = vi.fn();
const deleteAttachmentsForMessage = vi.fn();
const getProject = vi.fn();
const streamChat = vi.fn();
const checkTokenBudget = vi.fn();
const getConversationExtensionMimes = vi.fn();
const getExtensionMimesByNames = vi.fn();
const validateAttachment = vi.fn();
const writeAttachment = vi.fn();
const deleteForMessage = vi.fn();
const getEzAction = vi.fn();

const getCapabilitiesWithExtensions = vi.fn();
const classifyMimeWithCaps = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  getConversationPath,
  getMessages,
  getMessagesWithToolCalls,
  getSubConversationToolCalls,
  createMessage,
}));

vi.mock("$server/db/queries/attachments", () => ({
  insertAttachment,
  deleteAttachmentsForMessage,
}));

vi.mock("$server/db/queries/projects", () => ({
  getProject,
}));

vi.mock("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionMimes,
  getExtensionMimesByNames,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ streamChat }),
  // Coverage file deliberately uses the disabled goal-host path — the
  // goal-specific test file owns rehydrate + dispatch coverage.
  getGoalHost: () => null,
}));

vi.mock("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget,
}));

vi.mock("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

vi.mock("$server/providers/model-capabilities", () => ({
  getCapabilitiesWithExtensions,
  classifyMimeWithCaps,
}));

vi.mock("$server/chat/attachments/validator", () => ({
  validateAttachment,
}));

vi.mock("$server/chat/attachments/storage", () => ({
  writeAttachment,
  deleteForMessage,
}));

vi.mock("$server/runtime/ez-actions/registry", () => ({
  getEzAction,
}));

const { GET, POST } = await import(
  "../routes/api/conversations/[id]/messages/+server.ts"
);

// ── Event helpers ───────────────────────────────────────────────────

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

function makeGetEvent(opts: { query?: string; locals?: Record<string, unknown> }) {
  const href = `http://localhost/api/conversations/c1/messages${
    opts.query ? `?${opts.query}` : ""
  }`;
  return {
    url: new URL(href),
    locals: opts.locals ?? { user },
    params: { id: "c1" },
    request: new Request(href, { method: "GET" }),
  } as any;
}

function makeJsonPostEvent(opts: { body: unknown; locals?: Record<string, unknown> }) {
  const href = "http://localhost/api/conversations/c1/messages";
  return {
    url: new URL(href),
    locals: opts.locals ?? { user },
    params: { id: "c1" },
    request: new Request(href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
    }),
  } as any;
}

function makeMultipartEvent(opts: {
  form: FormData;
  locals?: Record<string, unknown>;
}) {
  // jsdom's `File` does not satisfy undici's webidl.is.File predicate,
  // so a real `new Request(href, { body: formData })` round-tripped
  // through `request.formData()` throws on every test under vitest.
  // We sidestep the round-trip by hand-rolling a minimal RequestEvent-
  // shaped object whose `request.formData()` returns the FormData
  // directly and whose `headers.get('content-type')` lies about being
  // multipart so the route's `isMultipart` branch dispatches.
  const href = "http://localhost/api/conversations/c1/messages";
  const headers = new Headers({
    "content-type": "multipart/form-data; boundary=stub",
  });
  return {
    url: new URL(href),
    locals: opts.locals ?? { user },
    params: { id: "c1" },
    request: {
      method: "POST",
      headers,
      formData: async () => opts.form,
    },
  } as any;
}

// ── Shared per-test state ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  getConversation.mockResolvedValue({
    id: "c1",
    userId: "u1",
    projectId: "p1",
    agentConfigId: null,
    modeId: null,
    provider: "openai",
    model: "gpt-4",
    parentConversationId: null,
  });
  getLatestLeaf.mockResolvedValue(null);
  createMessage.mockImplementation(
    async (
      _conversationId: string,
      data: { role: string; content: string; parentMessageId?: string },
    ) => ({
      id: data.role === "user" ? "m1" : `row-${Math.random().toString(36).slice(2, 8)}`,
      role: data.role,
      content: data.content,
      parentMessageId: data.parentMessageId ?? null,
    }),
  );
  vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
  streamChat.mockReturnValue({ catch: (_cb: any) => Promise.resolve() } as any);

  // Attachment-pipeline defaults — most tests don't ship files so these
  // only matter when a test opts into multipart.
  getConversationExtensionMimes.mockResolvedValue([]);
  getExtensionMimesByNames.mockReturnValue([]);
  getCapabilitiesWithExtensions.mockReturnValue({ maxFilesPerMessage: 4 });
  classifyMimeWithCaps.mockReturnValue("text");
  validateAttachment.mockResolvedValue({ ok: true, canonicalMime: "text/plain" });
  writeAttachment.mockResolvedValue({ storagePath: "/tmp/x", sizeBytes: 12 });
  insertAttachment.mockResolvedValue({
    id: "att-1",
    filename: "a.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    kind: "text",
  });
  deleteAttachmentsForMessage.mockResolvedValue(undefined);
  deleteForMessage.mockResolvedValue(undefined);
  getProject.mockResolvedValue({ id: "p1", path: "/tmp/project" });
  getEzAction.mockReturnValue(null);
});

// ── GET handler — query-string branches ─────────────────────────────

describe("GET — query-string branches", () => {
  test("?all=true → returns convQueries.getMessages payload", async () => {
    getMessages.mockResolvedValue([{ id: "m-all", role: "user", content: "x" }]);
    const res = await GET(makeGetEvent({ query: "all=true" }));
    expect(res.status).toBe(200);
    expect(getMessages).toHaveBeenCalledWith("c1");
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body[0]!.id).toBe("m-all");
  });

  test("?leafMessageId=X → returns the explicit-leaf walk", async () => {
    getConversationPath.mockResolvedValue([{ id: "path-1" }]);
    const res = await GET(makeGetEvent({ query: "leafMessageId=L1" }));
    expect(res.status).toBe(200);
    expect(getConversationPath).toHaveBeenCalledWith("L1", "c1");
  });

  test("?withToolCalls=true → returns base + subConversationToolCalls", async () => {
    getMessagesWithToolCalls.mockResolvedValue({ messages: [], toolCalls: [] });
    getSubConversationToolCalls.mockResolvedValue([{ id: "sub-tc" }]);
    const res = await GET(makeGetEvent({ query: "withToolCalls=true" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subConversationToolCalls: Array<{ id: string }> };
    expect(body.subConversationToolCalls[0]!.id).toBe("sub-tc");
  });

  test("happy path with a leaf → returns getConversationPath(leaf.id, conv)", async () => {
    getLatestLeaf.mockResolvedValue({ id: "leaf-x" });
    getConversationPath.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    const res = await GET(makeGetEvent({}));
    expect(res.status).toBe(200);
    expect(getConversationPath).toHaveBeenCalledWith("leaf-x", "c1");
  });
});

// ── POST handler — multipart parsing ────────────────────────────────

describe("POST — multipart parsing", () => {
  test("multipart with empty content → 400", async () => {
    const fd = new FormData();
    fd.set("content", "");
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("content is required");
  });

  test("multipart with content + zero files → falls through to streamChat", async () => {
    const fd = new FormData();
    fd.set("content", "hello multipart");
    fd.set("provider", "openai");
    fd.set("model", "gpt-4");
    fd.set("permissionMode", "auto-edit");
    fd.set("thinkingLevel", "medium");
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(200);
    expect(streamChat).toHaveBeenCalledTimes(1);
    // Verify the parsed body propagated to streamChat options.
    const opts = streamChat.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.provider).toBe("openai");
    expect(opts.model).toBe("gpt-4");
    expect(opts.permissionMode).toBe("auto-edit");
    expect(opts.thinkingLevel).toBe("medium");
  });

  test("multipart with an enum field set to a disallowed value → coerced to undefined", async () => {
    const fd = new FormData();
    fd.set("content", "x");
    fd.set("permissionMode", "not-a-real-mode");
    fd.set("thinkingLevel", "WAY-TOO-HIGH");
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(200);
    const opts = streamChat.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.permissionMode).toBeUndefined();
    expect(opts.thinkingLevel).toBeUndefined();
  });
});

// ── POST handler — attachments pipeline ─────────────────────────────

function makeMultipartWithFile(text: string, filename = "a.txt", mime = "text/plain") {
  const fd = new FormData();
  fd.set("content", "with attachment");
  fd.set("provider", "openai");
  fd.set("model", "gpt-4");
  const file = new File([text], filename, { type: mime });
  fd.append("files", file);
  return fd;
}

describe("POST — attachments: provider/model required", () => {
  test("no provider/model + files → 400", async () => {
    // Override the conversation's default provider/model so the request
    // has no source for them.
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      projectId: "p1",
      agentConfigId: null,
      modeId: null,
      provider: null,
      model: null,
      parentConversationId: null,
    });
    const fd = new FormData();
    fd.set("content", "x");
    fd.append("files", new File(["hi"], "a.txt", { type: "text/plain" }));
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provider and model are required");
  });
});

describe("POST — attachments: mime-set fallbacks tolerate throws", () => {
  test("getConversationExtensionMimes throws → swallowed, fallback to static caps", async () => {
    getConversationExtensionMimes.mockRejectedValue(new Error("db down"));
    const fd = makeMultipartWithFile("hello");
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(200);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("getExtensionMimesByNames throws on pending !ext mentions → swallowed", async () => {
    getExtensionMimesByNames.mockImplementation(() => {
      throw new Error("registry down");
    });
    const fd = new FormData();
    fd.set("content", "hello ![ext:weather]");
    fd.set("provider", "openai");
    fd.set("model", "gpt-4");
    fd.append("files", new File(["hi"], "a.txt", { type: "text/plain" }));
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(200);
    // Function was invoked with the pending names list.
    expect(getExtensionMimesByNames).toHaveBeenCalledWith(["weather"]);
  });
});

describe("POST — attachments: file count + project + validator + persist", () => {
  test("files.length > caps.maxFilesPerMessage → 400 TOO_MANY_FILES", async () => {
    getCapabilitiesWithExtensions.mockReturnValue({ maxFilesPerMessage: 1 });
    const fd = new FormData();
    fd.set("content", "x");
    fd.set("provider", "openai");
    fd.set("model", "gpt-4");
    fd.append("files", new File(["a"], "a.txt", { type: "text/plain" }));
    fd.append("files", new File(["b"], "b.txt", { type: "text/plain" }));
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TOO_MANY_FILES");
  });

  test("project path missing → 500", async () => {
    getProject.mockResolvedValue({ id: "p1", path: null });
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Project path not resolvable");
  });

  test("validateAttachment rejects TOO_LARGE → 413", async () => {
    validateAttachment.mockResolvedValue({ ok: false, code: "TOO_LARGE" });
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("TOO_LARGE");
  });

  test("validateAttachment rejects BAD_MIME → 400", async () => {
    validateAttachment.mockResolvedValue({ ok: false, code: "BAD_MIME" });
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(400);
  });

  test("attachment persist throws → 500 + rollback fires", async () => {
    insertAttachment.mockRejectedValue(new Error("disk full"));
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Failed to persist attachments");
    // Best-effort rollback: both disk + DB cleanups attempted.
    expect(deleteForMessage).toHaveBeenCalledTimes(1);
    expect(deleteAttachmentsForMessage).toHaveBeenCalledTimes(1);
  });

  test("happy path with one file → streamChat invoked with attachments", async () => {
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userMessage: { attachments: Array<{ filename: string }> };
      attachments: Array<{ filename: string }>;
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]!.filename).toBe("a.txt");
    // streamChat saw the staged attachment list.
    const opts = streamChat.mock.calls[0]![2] as { attachments: unknown[] };
    expect(Array.isArray(opts.attachments)).toBe(true);
    expect(opts.attachments).toHaveLength(1);
  });

  test("classifyMimeWithCaps returns null → persist throws + rolls back to 500", async () => {
    classifyMimeWithCaps.mockReturnValue(null);
    const res = await POST(makeMultipartEvent({ form: makeMultipartWithFile("hi") }));
    expect(res.status).toBe(500);
    expect(deleteForMessage).toHaveBeenCalled();
    expect(deleteAttachmentsForMessage).toHaveBeenCalled();
  });
});

// ── POST handler — EZ Actions dispatch ──────────────────────────────

describe("POST — EZ Actions", () => {
  test("unknown EZ action name → silent strip; no row persisted, streamChat still fires", async () => {
    getEzAction.mockReturnValue(null);
    const res = await POST(
      makeJsonPostEvent({ body: { content: "hello ![EZ:nothere]" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
    };
    expect(body.runId).not.toBeNull();
    expect(body.ezActionResults).toEqual([]);
    // Stripped message ('hello ') is non-empty → LLM call still goes.
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("known EZ action handler resolves → persisted row + streamChat continues (mixed message)", async () => {
    const handler = vi.fn(async () => ({
      kind: "success" as const,
      card: { title: "Pinged", body: "ok", variant: "info" as const },
    }));
    getEzAction.mockReturnValue({ name: "ping", description: "x", handler });
    const res = await POST(
      makeJsonPostEvent({ body: { content: "do it ![EZ:ping]" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ content: string; role: string }>;
    };
    expect(body.runId).not.toBeNull(); // mixed message — LLM still fires
    expect(body.ezActionResults).toHaveLength(1);
    expect(body.ezActionResults[0]!.role).toBe("ez-action-result");
    const parsed = JSON.parse(body.ezActionResults[0]!.content) as {
      card: { title: string };
    };
    expect(parsed.card.title).toBe("Pinged");
    expect(handler).toHaveBeenCalledWith({
      conversationId: "c1",
      userId: "u1",
      projectId: "p1",
    });
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("EZ action handler throws → error card persisted, streamChat continues", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    getEzAction.mockReturnValue({ name: "explode", description: "x", handler });
    const res = await POST(
      makeJsonPostEvent({ body: { content: "still talking ![EZ:explode]" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ezActionResults: Array<{ content: string }>;
      runId: string | null;
    };
    expect(body.runId).not.toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    const parsed = JSON.parse(body.ezActionResults[0]!.content) as {
      kind: string;
      card: { title: string; body: string; variant: string };
    };
    expect(parsed.kind).toBe("error");
    expect(parsed.card.title).toBe("Action failed");
    expect(parsed.card.body).toContain("explode");
    expect(parsed.card.variant).toBe("error");
  });

  test("EZ action-only message → no streamChat, runId:null, persisted row", async () => {
    const handler = vi.fn(async () => ({
      kind: "success" as const,
      card: { title: "Done", body: "ok", variant: "info" as const },
    }));
    getEzAction.mockReturnValue({ name: "ping", description: "x", handler });
    const res = await POST(
      makeJsonPostEvent({ body: { content: "![EZ:ping]" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ content: string }>;
    };
    expect(body.runId).toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    expect(streamChat).not.toHaveBeenCalled();
  });

  test("EZ action-only message with attachments → no streamChat, runId:null, attachments echoed", async () => {
    const handler = vi.fn(async () => ({
      kind: "success" as const,
      card: { title: "Done", body: "ok", variant: "info" as const },
    }));
    getEzAction.mockReturnValue({ name: "ping", description: "x", handler });
    const fd = new FormData();
    fd.set("content", "![EZ:ping]");
    fd.set("provider", "openai");
    fd.set("model", "gpt-4");
    fd.append("files", new File(["a"], "a.txt", { type: "text/plain" }));
    const res = await POST(makeMultipartEvent({ form: fd }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
      userMessage: { attachments?: unknown[] };
    };
    expect(body.runId).toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    expect(streamChat).not.toHaveBeenCalled();
    expect(body.userMessage.attachments).toHaveLength(1);
  });
});

// ── POST handler — streamPromise.catch logs error without throwing ──

describe("POST — streamChat rejection is logged via streamPromise.catch", () => {
  test("rejected streamChat doesn't crash the response", async () => {
    // streamChat returns a rejected promise — the route attaches a
    // `.catch` handler that just logs. The HTTP response still returns
    // 200 because the route doesn't await the stream completion.
    let rejected: Promise<unknown>;
    streamChat.mockImplementation(() => {
      rejected = Promise.reject(new Error("stream boom"));
      // Suppress unhandled-rejection — the route's own `.catch` does
      // this in production but vitest's runner needs us to attach a
      // shadow handler so the unhandled-rejection listener doesn't
      // fail the test.
      rejected.catch(() => {});
      return rejected as unknown as ReturnType<typeof streamChat>;
    });
    const res = await POST(
      makeJsonPostEvent({ body: { content: "hi" } }),
    );
    expect(res.status).toBe(200);
    expect(streamChat).toHaveBeenCalledTimes(1);
    // Wait one microtask so the route's `.catch` handler runs and the
    // log line is emitted — proves the catch arm executed at least once
    // (line 483 / log.error path).
    await Promise.resolve();
  });
});
