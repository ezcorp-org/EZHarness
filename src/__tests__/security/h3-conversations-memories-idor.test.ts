// Regression test for sec-H3: IDOR in /api/conversations/[id] and
// /api/memories/[id]. The pre-fix ownership check was:
//
//   if (row.userId && row.userId !== user.id) return null;  // or 404
//
// which short-circuited whenever `row.userId` was null. Rows with a null
// userId (e.g. tool-invoked / legacy sub-conversations) could therefore be
// read and mutated by any authenticated user. The fix changes the check to
// fail-closed: unowned rows are admin-only.
//
//   // sec-H3: fail-closed — unowned rows (null userId) are admin-only
//   if (row.userId !== user.id && user.role !== "admin") return null;
//
// This test covers the six files touched by the fix commit (the bytes
// actually landed in 17bd34d; the tracer commit eaac327 cites it):
//
//   1. web/src/routes/api/conversations/[id]/+server.ts          (GET/PUT/DELETE)
//   2. web/src/routes/api/conversations/[id]/messages/+server.ts (GET/POST)
//   3. web/src/routes/api/conversations/[id]/tasks/+server.ts    (GET)
//   4. web/src/routes/api/conversations/[id]/export/+server.ts   (GET)
//   5. web/src/routes/api/conversations/[id]/agent-chat/+server.ts (POST)
//   6. web/src/routes/api/memories/[id]/+server.ts               (GET/PUT/DELETE)
//
// Strategy:
//   (A) Source-level regression gates on all six files — the direct
//       regression signal. The fixed pattern `&& user.role !== "admin"`
//       is unambiguous and was not present pre-fix. The pre-fix short-
//       circuit `row.userId &&` before the `!==` comparison is absent
//       post-fix. Both gates flip together.
//
//   (B) Behavioral probes on the two canonical handlers
//       (conversations/[id]/+server.ts and memories/[id]/+server.ts)
//       using the standard mock-request helper. These prove the fixed
//       code path produces 404 for a non-admin on a null-owner row and
//       200 for an admin. A pre-fix build returns 200 in both cases.
//
// Other H3 sites (tasks/+server.ts, messages/+server.ts, export/+server.ts,
// agent-chat/+server.ts) are gated by the source assertions — behavioral
// coverage for tasks/+server.ts already exists in web/src/__tests__/tasks-api.test.ts
// ("returns 404 for non-admin on null-owner conversation (fail-closed)"),
// so we don't re-test it here.
//
// Tests fix(sec-H3): eaac327

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

mockServerAlias();

// $types stubs so SvelteKit's generated types don't trip the loader.
mock.module("../../../web/src/routes/api/conversations/[id]/$types", () => ({}));
mock.module("../../../web/src/routes/api/memories/[id]/$types", () => ({}));

// Stub web/src/lib/server/security/api-keys (scope check = noop allow).
const apiKeysMock = () => ({
  requireScope: () => null,
});
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module(
  "../../../web/src/lib/server/security/api-keys",
  apiKeysMock,
);

// validation helper — re-export the real module so validationError works.
mock.module("$lib/server/security/validation", () =>
  require("../../../web/src/lib/server/security/validation"),
);

// Auth middleware: requireAuth returns whatever we put into locals.user.
// Mocked at BOTH specifiers per the dual-specifier lesson — the handler
// imports `$server/auth/middleware`, which aliases to the same file that
// `../../auth/middleware` points to; Bun's loader caches them distinctly.
const authMiddlewareMock = () => ({
  requireAuth: (locals: any) => {
    if (!locals?.user) {
      throw new Response("Unauthorized", { status: 401 });
    }
    return locals.user;
  },
});
mock.module("$server/auth/middleware", authMiddlewareMock);
mock.module("../../auth/middleware", authMiddlewareMock);

// ── In-memory conversation + memory stores ───────────────────────

type Conversation = {
  id: string;
  userId: string | null;
  title: string;
  projectId: string | null;
  provider?: string | null;
  model?: string | null;
  modeId?: string | null;
  agentConfigId?: string | null;
};

type Memory = {
  id: string;
  userId: string | null;
  content: string;
  status: string;
};

let convStore: Map<string, Conversation>;
let memoryStore: Map<string, Memory>;

const convQueriesMock = () => ({
  getConversation: async (id: string) => convStore.get(id) ?? null,
  updateConversation: async (id: string, data: Partial<Conversation>) => {
    const existing = convStore.get(id);
    if (!existing) return null;
    const next = { ...existing, ...data };
    convStore.set(id, next);
    return next;
  },
  deleteConversation: async (id: string) => convStore.delete(id),
  // Unused by /api/conversations/[id]/+server.ts but safe stubs:
  getMessages: async () => [],
  getLatestLeaf: async () => null,
  getConversationPath: async () => [],
  getMessagesWithToolCalls: async () => [],
  createMessage: async () => ({
    id: "msg-1",
    createdAt: new Date().toISOString(),
  }),
});
mock.module("$server/db/queries/conversations", convQueriesMock);
mock.module("../../db/queries/conversations", convQueriesMock);

const memoriesMock = () => ({
  getMemoryById: async (id: string) => memoryStore.get(id) ?? null,
  updateMemory: async () => {},
  updateMemoryStatus: async () => {},
  deleteMemory: async (id: string) => memoryStore.delete(id),
  getMemoryProjectIds: async () => [] as string[],
  setMemoryProjects: async () => {},
});
mock.module("$server/db/queries/memories", memoriesMock);
mock.module("../../db/queries/memories", memoriesMock);

// Modes: the conversation PUT resolves a caller-supplied `modeId` through
// `getVisibleMode` before writing it. Re-implementing the visibility RULE here
// would let the mock and the real query drift, so the fake is a store plus the
// real predicate's shape only — `modes.test.ts` owns the rule itself against a
// real DB. Keyed by id; `null` means "not visible to this caller".
type Mode = { id: string; slug: string; builtin: boolean; userId: string | null };
let modeStore: Map<string, Mode>;

const modesMock = () => ({
  getMode: async (id: string) => modeStore.get(id),
  getVisibleMode: async (id: string, userId: string) => {
    const mode = modeStore.get(id);
    if (!mode) return null;
    if (!mode.builtin && mode.userId && mode.userId !== userId) return null;
    return mode;
  },
});
mock.module("$server/db/queries/modes", modesMock);
mock.module("../../db/queries/modes", modesMock);

// embeddings is imported lazily by the PUT handler if content changes;
// stub to an inert shape so the dynamic import doesn't pull in real deps.
const embeddingsMock = () => ({
  generateEmbedding: async () => new Array(4).fill(0),
});
mock.module("$server/memory/embeddings", embeddingsMock);
mock.module("../../memory/embeddings", embeddingsMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
import {
  GET as convGet,
  PUT as convPut,
  DELETE as convDelete,
} from "../../../web/src/routes/api/conversations/[id]/+server";
import {
  GET as memGet,
  PUT as memPut,
  DELETE as memDelete,
} from "../../../web/src/routes/api/memories/[id]/+server";

// SvelteKit handlers sometimes throw Response on auth failure; unwrap.
async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

const MODE_OWNED_A = "00000000-0000-4000-8000-0000000000a1";
const MODE_OWNED_B = "00000000-0000-4000-8000-0000000000b1";
const MODE_BUILTIN = "00000000-0000-4000-8000-0000000000c1";
const MODE_ORPHAN = "00000000-0000-4000-8000-0000000000d1";

beforeEach(() => {
  convStore = new Map<string, Conversation>([
    // Conversation owned by user-a
    [
      "conv-owned-a",
      {
        id: "conv-owned-a",
        userId: "user-a",
        title: "A's conversation",
        projectId: null,
      },
    ],
    // Conversation with null userId — the exploited branch
    [
      "conv-null-owner",
      {
        id: "conv-null-owner",
        userId: null,
        title: "Unowned (legacy) conversation",
        projectId: null,
      },
    ],
  ]);
  // `updateConversationSchema.modeId` is `z.string().uuid()`, so every id here
  // must be a real UUID or the handler 400s at validation before reaching the
  // visibility gate. (The SEEDED builtins are text literals — `builtin-plan`,
  // `builtin-ez` — and therefore cannot be set through PUT at all today; the
  // `MODE_BUILTIN` row below stands in for the shape, not for a seeded id.)
  modeStore = new Map<string, Mode>([
    [MODE_OWNED_A, { id: MODE_OWNED_A, slug: "a-private", builtin: false, userId: "user-a" }],
    [MODE_OWNED_B, { id: MODE_OWNED_B, slug: "b-private", builtin: false, userId: "user-b" }],
    [MODE_BUILTIN, { id: MODE_BUILTIN, slug: "plan", builtin: true, userId: null }],
    [MODE_ORPHAN, { id: MODE_ORPHAN, slug: "orphan", builtin: false, userId: null }],
  ]);
  memoryStore = new Map<string, Memory>([
    [
      "mem-owned-a",
      {
        id: "mem-owned-a",
        userId: "user-a",
        content: "A's secret memory",
        status: "active",
      },
    ],
    [
      "mem-null-owner",
      {
        id: "mem-null-owner",
        userId: null,
        content: "Unowned (legacy) memory",
        status: "active",
      },
    ],
  ]);
});

const USER_A = { id: "user-a", email: "a@test.local", name: "User A", role: "member" } as const;
const USER_B = { id: "user-b", email: "b@test.local", name: "User B", role: "member" } as const;

// ── (A) Source-level regression gates ─────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const H3_FILES = [
  "web/src/routes/api/conversations/[id]/+server.ts",
  "web/src/routes/api/conversations/[id]/messages/+server.ts",
  "web/src/routes/api/conversations/[id]/tasks/+server.ts",
  "web/src/routes/api/conversations/[id]/export/+server.ts",
  "web/src/routes/api/conversations/[id]/agent-chat/+server.ts",
  "web/src/routes/api/memories/[id]/+server.ts",
];

describe("sec-H3: all call sites have the fail-closed ownership check (source)", () => {
  for (const rel of H3_FILES) {
    const src = readFileSync(resolve(REPO_ROOT, rel), "utf8");

    test(`${rel} — contains the fail-closed admin escape hatch`, () => {
      // The fixed code gates unowned rows behind `user.role !== "admin"`.
      // Pre-fix no file contained this token. The exact shape varies a bit:
      //   - inline: four files keep the literal
      //     `<row>.userId !== user.id && user.role !== "admin"` check.
      //   - delegated: messages/+server.ts and agent-chat/+server.ts now
      //     route ownership through the shared helper
      //     `resolveRootConversationForOwnership(...)`, which itself applies
      //     the IDENTICAL fail-closed gate
      //     (`root.userId !== user.id && user.role !== "admin"` →
      //     null ⇒ 404) on the parent-walked ROOT owner. That is strictly
      //     stronger than the old inline check (a sub-conv with userId=null
      //     is now authorized against its owning root rather than being
      //     freely readable), so accepting the helper call preserves — not
      //     relaxes — the regression signal. The helper's own gate is pinned
      //     directly by web/src/lib/server/conversation-ownership.ts.
      // Require EITHER the inline role-gate OR the helper delegation.
      expect(src).toMatch(
        /user\.role\s*!==\s*"admin"|resolveRootConversationForOwnership/,
      );
    });

    test(`${rel} — does NOT short-circuit on null conv/memory userId`, () => {
      // The exploitable pre-fix patterns all had one of:
      //   if (conv.userId && conv.userId !== user.id)
      //   if (parentConv.userId && parentConv.userId !== user.id)
      //   if (memory.userId && memory.userId !== user.id)
      // Post-fix the leading `<row>.userId &&` truthiness short-circuit is
      // gone from every call site.
      expect(src).not.toMatch(/conv\.userId\s*&&\s*conv\.userId\s*!==\s*user\.id/);
      expect(src).not.toMatch(/memory\.userId\s*&&\s*memory\.userId\s*!==\s*user\.id/);
      expect(src).not.toMatch(/parentConv\.userId\s*&&\s*parentConv\.userId\s*!==\s*user\.id/);
    });
  }
});

// The two delegated call sites (messages/+server.ts, agent-chat/+server.ts)
// push the entire fail-closed decision into the shared ownership helper, so
// the regression signal for those routes lives HERE. Pin the helper directly:
// it must still gate the parent-walked root behind the admin escape hatch and
// must NOT reintroduce the exploitable `root.userId &&` truthiness short-circuit.
describe("sec-H3: shared ownership helper is itself fail-closed (source)", () => {
  const HELPER_REL = "web/src/lib/server/conversation-ownership.ts";
  const helperSrc = readFileSync(resolve(REPO_ROOT, HELPER_REL), "utf8");

  test(`${HELPER_REL} — gates the parent-walked root behind admin`, () => {
    expect(helperSrc).toMatch(/root\.userId\s*!==\s*user\.id\s*&&\s*user\.role\s*!==\s*"admin"/);
  });

  test(`${HELPER_REL} — does NOT short-circuit on null root userId`, () => {
    expect(helperSrc).not.toMatch(/root\.userId\s*&&\s*root\.userId\s*!==\s*user\.id/);
  });
});

// ── (B) Behavioral probes on the canonical handlers ───────────────

describe("sec-H3: GET /api/conversations/[id]", () => {
  test("owner (user-a) reading their own conversation → 200", async () => {
    const res = await call(
      convGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        user: USER_A as any,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe("conv-owned-a");
  });

  test("non-owner (user-b) reading user-a's conversation → 404", async () => {
    const res = await call(
      convGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(body).toEqual({ error: "Not found" });
  });

  test("member reading a null-owner conversation → 404 (fail-closed)", async () => {
    // This is the exploited branch. Pre-fix any authenticated user got 200.
    const res = await call(
      convGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner",
        params: { id: "conv-null-owner" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    // Must NOT have exposed the unowned conversation in the body.
    expect(JSON.stringify(body)).not.toContain("Unowned (legacy) conversation");
  });

  test("admin reading a null-owner conversation → 200", async () => {
    const res = await call(
      convGet as any,
      createMockEvent({
        url: "http://localhost/api/conversations/conv-null-owner",
        params: { id: "conv-null-owner" },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe("conv-null-owner");
  });
});

describe("sec-H3: PUT /api/conversations/[id]", () => {
  test("non-owner PATCH-style PUT on user-a's conversation → 404 (no mutation)", async () => {
    const res = await call(
      convPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        body: { title: "hijacked-by-user-b" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    // Store must be untouched.
    expect(convStore.get("conv-owned-a")?.title).toBe("A's conversation");
  });

  test("member PUT on null-owner conversation → 404 (fail-closed, no mutation)", async () => {
    const res = await call(
      convPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/conversations/conv-null-owner",
        params: { id: "conv-null-owner" },
        body: { title: "hijacked-null-owner" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    expect(convStore.get("conv-null-owner")?.title).toBe("Unowned (legacy) conversation");
  });
});

// ── modeId visibility on PUT ──────────────────────────────────────
//
// Owning the CONVERSATION is not the whole authorization: the caller also
// supplies the MODE id being written into it. This route used to check neither
// existence nor owner and leaned on the FK, which made it the looser half of a
// pair — `POST /api/conversations` resolves the same id through the same
// `getVisibleMode`, and a create path stricter than the update path is not a
// boundary, it is two calls. Every arm below is user-a acting on user-a's OWN
// conversation, so the only thing under test is the mode.
//
// This matters past tidiness: a per-key confinement that compares the
// PERSISTED `conv.modeId` against a locked mode is only as good as the writes
// that can reach that column.
describe("sec-H3: PUT /api/conversations/[id] — modeId must be visible to the caller", () => {
  const putMode = (modeId: unknown) =>
    call(
      convPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        body: { modeId },
        user: USER_A as any,
      }),
    );

  test("another user's private mode → 404, and the column is NOT written", async () => {
    const res = await putMode(MODE_OWNED_B);
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    // Same message as a missing mode: the route must not confirm the id exists.
    expect(body.error).toBe("Mode not found");
    expect(convStore.get("conv-owned-a")?.modeId).toBeUndefined();
  });

  test("a mode that does not exist → the SAME 404 (no existence oracle)", async () => {
    const res = await putMode("00000000-0000-4000-8000-00000000dead");
    expect(res.status).toBe(404);
    expect(await jsonFromResponse(res)).toEqual(
      expect.objectContaining({ error: "Mode not found" }),
    );
    expect(convStore.get("conv-owned-a")?.modeId).toBeUndefined();
  });

  test("the caller's OWN private mode → 200 and persisted", async () => {
    const res = await putMode(MODE_OWNED_A);
    expect(res.status).toBe(200);
    expect(convStore.get("conv-owned-a")?.modeId).toBe(MODE_OWNED_A);
  });

  test("a builtin mode → 200 whoever authored it", async () => {
    const res = await putMode(MODE_BUILTIN);
    expect(res.status).toBe(200);
    expect(convStore.get("conv-owned-a")?.modeId).toBe(MODE_BUILTIN);
  });

  test("an ownerless non-builtin mode → 200 (userId is ON DELETE SET NULL)", async () => {
    // Deleting a mode's author orphans the row rather than deleting it.
    // Refusing orphans here would take a working mode away from every
    // conversation already using one — a bigger hole than the one being
    // closed, so the guard fires only on a mode owned by SOMEONE ELSE.
    const res = await putMode(MODE_ORPHAN);
    expect(res.status).toBe(200);
    expect(convStore.get("conv-owned-a")?.modeId).toBe(MODE_ORPHAN);
  });

  test("modeId: null clears the mode without a lookup", async () => {
    // Clearing needs no authorization beyond the conversation ownership already
    // checked — and a null must never be fed to the visibility gate, which
    // would 404 a legitimate reset.
    convStore.get("conv-owned-a")!.modeId = MODE_OWNED_A;
    const res = await putMode(null);
    expect(res.status).toBe(200);
    expect(convStore.get("conv-owned-a")?.modeId).toBeNull();
  });

  test("a PUT that does not mention modeId is untouched by the gate", async () => {
    convStore.get("conv-owned-a")!.modeId = MODE_OWNED_A;
    const res = await call(
      convPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        body: { title: "Renamed by the owner" },
        user: USER_A as any,
      }),
    );
    expect(res.status).toBe(200);
    expect(convStore.get("conv-owned-a")?.title).toBe("Renamed by the owner");
    // The existing mode survives a title-only edit.
    expect(convStore.get("conv-owned-a")?.modeId).toBe(MODE_OWNED_A);
  });
});

describe("sec-H3: DELETE /api/conversations/[id]", () => {
  test("non-owner cannot delete user-a's conversation", async () => {
    const res = await call(
      convDelete as any,
      createMockEvent({
        method: "DELETE",
        url: "http://localhost/api/conversations/conv-owned-a",
        params: { id: "conv-owned-a" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    expect(convStore.has("conv-owned-a")).toBe(true);
  });

  test("member cannot delete a null-owner conversation (fail-closed)", async () => {
    const res = await call(
      convDelete as any,
      createMockEvent({
        method: "DELETE",
        url: "http://localhost/api/conversations/conv-null-owner",
        params: { id: "conv-null-owner" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    expect(convStore.has("conv-null-owner")).toBe(true);
  });
});

describe("sec-H3: GET /api/memories/[id]", () => {
  test("owner reading their own memory → 200", async () => {
    const res = await call(
      memGet as any,
      createMockEvent({
        url: "http://localhost/api/memories/mem-owned-a",
        params: { id: "mem-owned-a" },
        user: USER_A as any,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe("mem-owned-a");
    expect(body.content).toBe("A's secret memory");
  });

  test("non-owner reading user-a's memory → 404", async () => {
    const res = await call(
      memGet as any,
      createMockEvent({
        url: "http://localhost/api/memories/mem-owned-a",
        params: { id: "mem-owned-a" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("A's secret memory");
  });

  test("member reading a null-owner memory → 404 (fail-closed)", async () => {
    const res = await call(
      memGet as any,
      createMockEvent({
        url: "http://localhost/api/memories/mem-null-owner",
        params: { id: "mem-null-owner" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("Unowned (legacy) memory");
  });

  test("admin reading a null-owner memory → 200", async () => {
    const res = await call(
      memGet as any,
      createMockEvent({
        url: "http://localhost/api/memories/mem-null-owner",
        params: { id: "mem-null-owner" },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.id).toBe("mem-null-owner");
  });
});

describe("sec-H3: PUT /api/memories/[id]", () => {
  test("non-owner PUT on user-a's memory → 404 (no mutation)", async () => {
    const res = await call(
      memPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/memories/mem-owned-a",
        params: { id: "mem-owned-a" },
        body: { content: "hijacked-content" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
  });

  test("member PUT on null-owner memory → 404 (fail-closed)", async () => {
    const res = await call(
      memPut as any,
      createMockEvent({
        method: "PUT",
        url: "http://localhost/api/memories/mem-null-owner",
        params: { id: "mem-null-owner" },
        body: { content: "hijacked-null-owner" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("sec-H3: DELETE /api/memories/[id]", () => {
  test("non-owner cannot delete user-a's memory", async () => {
    const res = await call(
      memDelete as any,
      createMockEvent({
        method: "DELETE",
        url: "http://localhost/api/memories/mem-owned-a",
        params: { id: "mem-owned-a" },
        user: USER_B as any,
      }),
    );
    expect(res.status).toBe(404);
    expect(memoryStore.has("mem-owned-a")).toBe(true);
  });

  test("member cannot delete a null-owner memory (fail-closed)", async () => {
    const res = await call(
      memDelete as any,
      createMockEvent({
        method: "DELETE",
        url: "http://localhost/api/memories/mem-null-owner",
        params: { id: "mem-null-owner" },
        user: MEMBER_USER,
      }),
    );
    expect(res.status).toBe(404);
    expect(memoryStore.has("mem-null-owner")).toBe(true);
  });
});
