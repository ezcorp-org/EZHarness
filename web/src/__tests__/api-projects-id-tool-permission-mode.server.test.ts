/**
 * Server-handler unit tests for
 * /api/projects/[id]/tool-permission-mode/+server.ts.
 *
 * The handler is thin: it gates on auth + API-key scope, then defers to the
 * shared tool-permission helper via dynamic import, wiring a bus emit into the
 * helper's `onModeChange` callback. Both halves are covered here — the scope
 * gate that runs BEFORE the dynamic import, and the delegation + emit that run
 * after it (the helper itself and its DB write are integration-tested against
 * real PGlite elsewhere; `vi.mock` stands in for it here).
 *
 * This is the coverage-authoritative leg for the route: bun `mock.module`
 * tests of web routes are excluded from the merged lcov, so route coverage
 * counts ONLY via vitest `vi.mock` (precedent:
 * `api-projects-id-features-scan.server.test.ts`). Until it was wired into
 * BOTH of scripts/test-coverage.sh's hand-maintained allowlists, the route had
 * no lcov data at all — which is why its `any` sat on `biome.json`'s
 * noExplicitAny opt-out list (issue #142).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── The shared helper the route dynamically imports ─────────────────
// Records the call and drives the `onModeChange` callback so the route's bus
// emit is actually exercised.
type SetCall = {
  projectId: string;
  body: unknown;
  options?: { onModeChange?: (mode: string, conversationId?: string) => void };
};
let setCalls: SetCall[] = [];
let getCalls: Array<{ projectId: string }> = [];
/** What the mocked helper feeds back through `onModeChange`, per test. */
let modeChange: { mode: string; conversationId?: string } | null = null;

vi.mock("$server/routes/tool-permission", () => ({
  handleGetPermissionMode: vi.fn(async (_req: Request, projectId: string) => {
    getCalls.push({ projectId });
    return new Response(JSON.stringify({ mode: "ask" }), { status: 200 });
  }),
  handleSetPermissionMode: vi.fn(
    async (req: Request, projectId: string, options?: SetCall["options"]) => {
      setCalls.push({ projectId, body: await req.json(), options });
      if (modeChange) options?.onModeChange?.(modeChange.mode, modeChange.conversationId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  ),
}));

// ── The runtime event bus ───────────────────────────────────────────
const emitted: Array<{ type: string; data: unknown }> = [];
vi.mock("$lib/server/context", () => ({
  getBus: () => ({ emit: (type: string, data: unknown) => emitted.push({ type, data }) }),
}));

import { GET, PUT } from "../routes/api/projects/[id]/tool-permission-mode/+server";

function makeEvent(opts: {
  id?: string;
  body?: unknown;
  locals?: Record<string, unknown>;
  method?: string;
}) {
  const id = opts.id ?? "p1";
  return {
    url: new URL(`http://localhost/api/projects/${id}/tool-permission-mode`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/projects/${id}/tool-permission-mode`, {
      method: opts.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const AUTHED = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
  apiKeyScopes: ["read", "chat"],
};

beforeEach(() => {
  setCalls = [];
  getCalls = [];
  emitted.length = 0;
  modeChange = null;
});

describe("GET /api/projects/[id]/tool-permission-mode", () => {
  test("returns 403 when API-key scope missing 'read'", async () => {
    const res = await GET(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["chat"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("read");
  });

  test("delegates to handleGetPermissionMode with the route's project id", async () => {
    const res = await GET(makeEvent({ id: "proj-7", locals: AUTHED }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "ask" });
    expect(getCalls).toEqual([{ projectId: "proj-7" }]);
  });
});

describe("PUT /api/projects/[id]/tool-permission-mode", () => {
  test("returns 403 when API-key scope missing 'chat'", async () => {
    const res = await PUT(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["read"],
        },
        method: "PUT",
        body: { mode: "ask" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("chat");
  });

  test("forwards the body and emits tool:permission_mode_change for a conversation", async () => {
    modeChange = { mode: "acceptEdits", conversationId: "conv-9" };
    const res = await PUT(
      makeEvent({
        id: "proj-7",
        locals: AUTHED,
        method: "PUT",
        body: { mode: "acceptEdits", conversationId: "conv-9" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]!.projectId).toBe("proj-7");
    expect(setCalls[0]!.body).toEqual({ mode: "acceptEdits", conversationId: "conv-9" });
    expect(emitted).toEqual([
      {
        type: "tool:permission_mode_change",
        data: { conversationId: "conv-9", mode: "acceptEdits" },
      },
    ]);
  });

  test("a project-wide change (no conversationId) emits nothing", async () => {
    // The event is per-conversation: without a conversation to scope it to,
    // broadcasting would push another chat's mode change into every client.
    modeChange = { mode: "plan" };
    const res = await PUT(makeEvent({ locals: AUTHED, method: "PUT", body: { mode: "plan" } }));
    expect(res.status).toBe(200);
    expect(setCalls).toHaveLength(1);
    expect(emitted).toEqual([]);
  });
});
