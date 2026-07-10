// HTTP route tests for `POST /api/extensions/[name]/uploads/+server.ts`.
//
// Mocks every DB / storage boundary so no real PGlite or filesystem
// writes happen — the route logic itself (auth + scope + extension
// wiring + permission gate + MIME whitelist + size cap) is the test
// surface here. The handler's underlying queries are covered by the
// upstream tests in their own modules.

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../../../src/__tests__/helpers/mock-cleanup";
import { mockServerAlias, MEMBER_USER } from "../../../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

mock.module("../../../../../../../../web/src/routes/api/extensions/[name]/uploads/$types", () => ({}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
// Real implementation passes through — the route file calls errorJson with
// concrete status + message arguments and we want the actual Response object
// shape to come out for the assertions.
import * as httpErrorsActual from "../../../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);

// ── Mocked DB modules ────────────────────────────────────────────

interface MockConv { id: string; userId: string; projectId: string }
interface MockExt { id: string; name: string; enabled: boolean; grantedPermissions: Record<string, unknown> }
interface MockMsg { id: string; conversationId: string; role: string }

let mockConv: MockConv | null = null;
let mockExt: MockExt | null = null;
let mockMsgs: MockMsg[] = [];
let mockWiredExtIds: string[] = [];
const insertCalls: Array<Record<string, unknown>> = [];
const writeCalls: Array<Record<string, unknown>> = [];

const convQueriesMock = () => ({
  getConversation: async (id: string) => (mockConv && mockConv.id === id ? mockConv : null),
  getMessages: async (_id: string) => mockMsgs,
});
mock.module("$server/db/queries/conversations", convQueriesMock);

mock.module("$server/db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => (mockExt && mockExt.name === name ? mockExt : null),
}));

mock.module("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => mockWiredExtIds,
}));

mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) => ({ id, name: "p", path: "/tmp/p" }),
}));

mock.module("$server/chat/attachments/storage", () => ({
  writeAttachment: async (opts: Record<string, unknown>) => {
    writeCalls.push(opts);
    return { storagePath: `/tmp/p/.ezcorp/attachments/x.wav`, sizeBytes: (opts.bytes as Uint8Array).byteLength };
  },
}));

mock.module("$server/db/queries/attachments", () => ({
  insertAttachment: async (data: Record<string, unknown>) => {
    insertCalls.push(data);
    return { id: "att-mock-1", ...data };
  },
}));

// Extension identity of the target message = the extension ids on its
// tool-call rows (append-message-handler persists them). Default: the
// message was minted by ext-1 (this extension) so every pre-existing
// suite runs unchanged; the binding tests below repoint it.
let mockMsgToolCallExtIds: string[] = [];
mock.module("$server/db/queries/tool-calls", () => ({
  listToolCallExtensionIdsForMessage: async (_messageId: string) => mockMsgToolCallExtIds,
}));

const { POST } = await import(
  "../../../../../../../../web/src/routes/api/extensions/[name]/uploads/+server"
);

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  mockConv = { id: "conv-1", userId: MEMBER_USER.id, projectId: "proj-1" };
  mockExt = {
    id: "ext-1",
    name: "kokoro-tts",
    enabled: true,
    grantedPermissions: { appendMessages: { excludedDefault: true } },
  };
  mockWiredExtIds = ["ext-1"];
  mockMsgs = [{ id: "msg-1", conversationId: "conv-1", role: "extension" }];
  mockMsgToolCallExtIds = ["ext-1"];
  insertCalls.length = 0;
  writeCalls.length = 0;
});

// ── Helpers ─────────────────────────────────────────────────────

// Pick a filename whose extension matches the MIME — Bun's multipart
// parser infers Content-Type from the extension, so a mismatch silently
// rewrites `audio/mpeg` → `audio/x-wav` etc.
function defaultFilenameFor(mime: string): string {
  if (mime === "audio/mpeg") return "x.mp3";
  if (mime.startsWith("image/png")) return "x.png";
  return "x.wav";
}

function makeForm(opts: {
  bytes?: Uint8Array;
  mime?: string;
  conversationId?: string;
  messageId?: string;
  filename?: string;
  omitFile?: boolean;
}): FormData {
  const form = new FormData();
  if (!opts.omitFile) {
    const mime = opts.mime ?? "audio/wav";
    const filename = opts.filename ?? defaultFilenameFor(mime);
    const blob = new Blob([(opts.bytes ?? new Uint8Array([1, 2, 3, 4])) as BlobPart], { type: mime });
    form.append("file", new File([blob], filename, { type: mime }));
  }
  form.append("conversationId", opts.conversationId ?? "conv-1");
  form.append("messageId", opts.messageId ?? "msg-1");
  return form;
}

function evt(form: FormData, name = "kokoro-tts", user: typeof MEMBER_USER | null = MEMBER_USER) {
  const request = new Request(`http://localhost/api/extensions/${name}/uploads`, {
    method: "POST",
    body: form,
  });
  return {
    request,
    url: new URL(request.url),
    params: { name },
    locals: { user: user ?? undefined },
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────

describe("uploads — auth gate", () => {
  test("missing user → 401", async () => {
    let res: Response;
    try {
      res = await POST(evt(makeForm({}), "kokoro-tts", null) as any);
    } catch (e) {
      // requireAuth throws Response on missing user
      res = e as Response;
    }
    expect(res!.status).toBe(401);
  });
});

describe("uploads — conversation gate", () => {
  test("conversation owned by another user → 404", async () => {
    mockConv = { id: "conv-1", userId: "someone-else", projectId: "proj-1" };
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(404);
  });

  test("unknown extension name → 404", async () => {
    mockExt = null;
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(404);
  });

  test("extension not wired to conversation → 404", async () => {
    mockWiredExtIds = ["other-ext"];
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(404);
  });

  test("extension lacks appendMessages permission → 403", async () => {
    mockExt!.grantedPermissions = {};
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(403);
  });
});

describe("uploads — message gate", () => {
  test("messageId not in conversation → 404", async () => {
    mockMsgs = [];
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(404);
  });

  test('messageId not role "extension" → 403', async () => {
    mockMsgs = [{ id: "msg-1", conversationId: "conv-1", role: "user" }];
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(403);
  });

  test("cross-extension attach rejected: message minted by ANOTHER extension → 403", async () => {
    // The target message is extension-authored, in this conversation,
    // and this extension is wired with appendMessages — but the
    // message's tool-call rows belong to a different extension. The
    // binding gate must refuse the attach.
    mockMsgToolCallExtIds = ["ext-other"];
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("does not belong to this extension");
    expect(insertCalls).toHaveLength(0);
  });

  test("message with NO tool-call rows has no recorded identity → 403", async () => {
    mockMsgToolCallExtIds = [];
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(403);
    expect(insertCalls).toHaveLength(0);
  });

  test("message minted by THIS extension passes the binding gate", async () => {
    // Default fixture: mockMsgToolCallExtIds = ["ext-1"] (this ext).
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(1);
  });
});

describe("uploads — MIME whitelist", () => {
  test("audio/wav accepted", async () => {
    const res = await POST(evt(makeForm({ mime: "audio/wav" })) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attachmentId).toBe("att-mock-1");
    expect(insertCalls[0]!.kind).toBe("audio");
    // Bun's multipart parser may normalize audio/wav → audio/x-wav;
    // we only assert it's one of the allowed audio aliases.
    expect(["audio/wav", "audio/x-wav", "audio/wave"]).toContain(insertCalls[0]!.mimeType as string);
  });

  test("audio/mpeg accepted", async () => {
    const res = await POST(evt(makeForm({ mime: "audio/mpeg" })) as any);
    expect(res.status).toBe(200);
    expect(insertCalls[0]!.mimeType).toBe("audio/mpeg");
  });

  test("image/png rejected → 400 UNSUPPORTED_MIME", async () => {
    const res = await POST(evt(makeForm({ mime: "image/png" })) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNSUPPORTED_MIME");
    expect(insertCalls).toHaveLength(0);
  });
});

describe("uploads — size cap", () => {
  test("25 MB + 1 byte rejected → 413 TOO_LARGE", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const res = await POST(evt(makeForm({ bytes: big })) as any);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("TOO_LARGE");
    expect(insertCalls).toHaveLength(0);
  });

  test("empty file rejected → 400", async () => {
    const empty = new Uint8Array(0);
    const res = await POST(evt(makeForm({ bytes: empty })) as any);
    expect(res.status).toBe(400);
  });
});

describe("uploads — happy path", () => {
  test("links attachment row to the supplied messageId", async () => {
    const res = await POST(evt(makeForm({})) as any);
    expect(res.status).toBe(200);
    expect(insertCalls[0]!.messageId).toBe("msg-1");
    expect(insertCalls[0]!.conversationId).toBe("conv-1");
    expect(writeCalls[0]!.messageId).toBe("msg-1");
  });
});

describe("uploads — body shape", () => {
  test("missing file → 400", async () => {
    const res = await POST(evt(makeForm({ omitFile: true })) as any);
    expect(res.status).toBe(400);
  });

  test("non-multipart body → 400", async () => {
    const request = new Request("http://localhost/api/extensions/kokoro-tts/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST({
      request,
      url: new URL(request.url),
      params: { name: "kokoro-tts" },
      locals: { user: MEMBER_USER },
    } as any);
    expect(res.status).toBe(400);
  });
});
