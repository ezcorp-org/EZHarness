// Tests for `GET /api/conversations/[id]/extension-toolbar/+server.ts`.
//
// The route returns the union of `messageToolbar[]` items declared by
// every extension wired into the conversation, clamped to the
// extension's own `eventSubscriptions` allowlist. We mock out the
// db-query layer + ExtensionRegistry singleton so the test stays
// laser-focused on the union/clamp logic.

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../../../src/__tests__/helpers/mock-cleanup";
import { mockServerAlias, MEMBER_USER } from "../../../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

mock.module("../../../../../../../../web/src/routes/api/conversations/[id]/extension-toolbar/$types", () => ({}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
// Real implementation passes through — the route returns concrete
// Response objects via errorJson() and the assertions inspect status codes.
import * as httpErrorsActual from "../../../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);

// ── Mocks ───────────────────────────────────────────────────────

interface MockConv { id: string; userId: string; projectId: string }
interface MockInstalledExt {
  id: string;
  name: string;
  enabled: boolean;
  manifest: Record<string, unknown>;
}
let mockConv: MockConv | null = null;
let mockInstalled: MockInstalledExt[] = [];

mock.module("$server/db/queries/conversations", () => ({
  getConversation: async (id: string) => (mockConv && mockConv.id === id ? mockConv : null),
}));

// Route now uses `listExtensions(true)` to enumerate every enabled
// extension. The wiring-derived shape (conversation_extensions +
// ExtensionRegistry) is gone — toolbar contributions are global UI.
mock.module("$server/db/queries/extensions", () => ({
  listExtensions: async (enabledOnly?: boolean) =>
    enabledOnly ? mockInstalled.filter((e) => e.enabled) : mockInstalled,
}));

const { GET } = await import(
  "../../../../../../../../web/src/routes/api/conversations/[id]/extension-toolbar/+server"
);

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  mockConv = { id: "conv-1", userId: MEMBER_USER.id, projectId: "proj-1" };
  mockInstalled = [];
});

function installExt(name: string, opts: {
  toolbar?: Array<Record<string, unknown>>;
  events?: string[];
  enabled?: boolean;
}): void {
  mockInstalled.push({
    id: `ext-${name}`,
    name,
    enabled: opts.enabled ?? true,
    manifest: manifest(name, { toolbar: opts.toolbar, events: opts.events }),
  });
}

function evt(id = "conv-1", user: typeof MEMBER_USER | null = MEMBER_USER) {
  return {
    request: new Request(`http://localhost/api/conversations/${id}/extension-toolbar`),
    url: new URL(`http://localhost/api/conversations/${id}/extension-toolbar`),
    params: { id },
    locals: { user: user ?? undefined },
  } as any;
}

function manifest(name: string, opts: {
  toolbar?: Array<Record<string, unknown>>;
  events?: string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: "t",
    author: { name: "t" },
    permissions: { eventSubscriptions: opts.events ?? [] },
    ...(opts.toolbar ? { messageToolbar: opts.toolbar } : {}),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("extension-toolbar — auth/scope gates", () => {
  test("missing user → 401", async () => {
    let res: Response;
    try {
      res = await GET(evt("conv-1", null) as any);
    } catch (e) {
      res = e as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("conversation owned by another user → 404", async () => {
    mockConv = { id: "conv-1", userId: "someone-else", projectId: "proj-1" };
    const res = await GET(evt() as any);
    expect(res.status).toBe(404);
  });

  test("unknown conversation → 404", async () => {
    mockConv = null;
    const res = await GET(evt() as any);
    expect(res.status).toBe(404);
  });
});

describe("extension-toolbar — empty state", () => {
  test("no installed extensions → empty list", async () => {
    const res = await GET(evt() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  test("installed extension with no messageToolbar → empty contribution", async () => {
    installExt("a", { events: ["a:speak"] });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });
});

describe("extension-toolbar — union of contributions", () => {
  test("two installed extensions → union of toolbar items", async () => {
    installExt("a", {
      events: ["a:speak"],
      toolbar: [{ id: "speak", icon: "Volume2", tooltip: "speak", appliesTo: "both", event: "a:speak" }],
    });
    installExt("b", {
      events: ["b:summarize"],
      toolbar: [{ id: "sum", icon: "FileText", tooltip: "sum", appliesTo: "assistant", event: "b:summarize" }],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    const byExt = new Map(body.items.map((i: any) => [i.extName, i]));
    expect(byExt.get("a")).toMatchObject({ id: "speak", event: "a:speak", appliesTo: "both" });
    expect(byExt.get("b")).toMatchObject({ id: "sum", event: "b:summarize", appliesTo: "assistant" });
  });

  test("appliesTo defaults to 'both' when omitted", async () => {
    installExt("a", {
      events: ["a:s"],
      toolbar: [{ id: "x", icon: "X", tooltip: "x", event: "a:s" }],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items[0].appliesTo).toBe("both");
  });

  test("appliesToSelection defaults to 'single' when omitted", async () => {
    // The bulk-mode SDK opt-in is conservative by default — existing
    // manifests that don't declare appliesToSelection must continue to
    // render only on the per-message toolbar (the original behavior).
    installExt("a", {
      events: ["a:s"],
      toolbar: [{ id: "x", icon: "X", tooltip: "x", event: "a:s" }],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items[0].appliesToSelection).toBe("single");
  });

  test("appliesToSelection is forwarded verbatim when declared", async () => {
    // Three items with the three distinct selection modes — the route
    // must round-trip each one so the frontend can filter by mode.
    installExt("a", {
      events: ["a:single", "a:bulk", "a:both"],
      toolbar: [
        { id: "s", icon: "S", tooltip: "s", event: "a:single", appliesToSelection: "single" },
        { id: "b", icon: "B", tooltip: "b", event: "a:bulk", appliesToSelection: "bulk" },
        { id: "x", icon: "X", tooltip: "x", event: "a:both", appliesToSelection: "both" },
      ],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    const byId = new Map((body.items as Array<{ id: string; appliesToSelection: string }>).map((it) => [it.id, it]));
    expect(byId.get("s")?.appliesToSelection).toBe("single");
    expect(byId.get("b")?.appliesToSelection).toBe("bulk");
    expect(byId.get("x")?.appliesToSelection).toBe("both");
  });
});

describe("extension-toolbar — event allowlist clamp", () => {
  test("toolbar entry whose event isn't in eventSubscriptions is OMITTED", async () => {
    // Two items declared, only one is in the allowlist.
    installExt("a", {
      events: ["a:allowed"],
      toolbar: [
        { id: "yes", icon: "Yes", tooltip: "yes", event: "a:allowed" },
        { id: "no", icon: "No", tooltip: "no", event: "a:rogue" },
      ],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items.map((i: any) => i.id)).toEqual(["yes"]);
  });

  test("manifest with empty eventSubscriptions → no items", async () => {
    installExt("a", {
      events: [],
      toolbar: [{ id: "rogue", icon: "X", tooltip: "x", event: "a:speak" }],
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });
});

describe("extension-toolbar — disabled extensions", () => {
  test("disabled extension is NOT included", async () => {
    installExt("a", {
      events: ["a:speak"],
      toolbar: [{ id: "ax", icon: "AX", tooltip: "ax", event: "a:speak" }],
      enabled: true,
    });
    installExt("b", {
      events: ["b:speak"],
      toolbar: [{ id: "bx", icon: "BX", tooltip: "bx", event: "b:speak" }],
      enabled: false,
    });
    const res = await GET(evt() as any);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].extName).toBe("a");
  });
});
