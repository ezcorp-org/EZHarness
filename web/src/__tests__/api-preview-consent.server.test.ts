/**
 * Vitest server-handler tests for `POST /api/preview/consent/+server.ts`
 * (Secure User-Site Preview / Port Exposure, Phase 2 — §3.3 + D3).
 *
 * Coverage:
 *   - 401 unauthenticated (requireAuth throws a Response)
 *   - 400 missing conversationId / bad JSON / unknown action / bad port
 *     (0 and >65535 both rejected)
 *   - "ignore" → 200 non-action, NEVER calls exposeDetectedPort
 *   - "expose" → 200, calls exposeDetectedPort with the SESSION user
 *     (requester-scoped — never a body userId), returns {previewId, code}
 *   - "always-expose" → sets the per-conversation pref THEN exposes
 *   - "disable-always" → clears the pref, no expose
 *
 * The consent service is mocked so the route's validation + requester
 * scoping is tested without a DB.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockExpose = vi.fn();
const mockSetAlways = vi.fn();
const mockClearAlways = vi.fn();
vi.mock("$server/runtime/preview/preview-consent", () => ({
  exposeDetectedPort: (...args: unknown[]) => mockExpose(...args),
  setAlwaysExpose: (...args: unknown[]) => mockSetAlways(...args),
  clearAlwaysExpose: (...args: unknown[]) => mockClearAlways(...args),
}));

const { POST } = await import("../routes/api/preview/consent/+server");

const USER = { id: "session-user", email: "u@x", name: "u", role: "member" } as const;

function makeEvent(opts: { body?: unknown; raw?: string; locals?: Record<string, unknown> }) {
  const href = "http://localhost/api/preview/consent";
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return {
    request: new Request(href, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    }),
    locals: opts.locals ?? { user: USER },
    url: new URL(href),
  } as never;
}

async function run(event: ReturnType<typeof makeEvent>): Promise<Response> {
  try {
    return await POST(event);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

beforeEach(() => {
  mockExpose.mockReset();
  mockSetAlways.mockReset();
  mockClearAlways.mockReset();
  mockExpose.mockResolvedValue({ previewId: "pid26", code: "code123", subdomainLabel: "pid26" });
});

describe("POST /api/preview/consent", () => {
  test("401 when unauthenticated", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", port: 5173, action: "expose" }, locals: {} }));
    expect(res.status).toBe(401);
    expect(mockExpose).not.toHaveBeenCalled();
  });

  test("400 on bad JSON", async () => {
    const res = await run(makeEvent({ raw: "{not json" }));
    expect(res.status).toBe(400);
  });

  test("400 when conversationId is missing", async () => {
    const res = await run(makeEvent({ body: { port: 5173, action: "expose" } }));
    expect(res.status).toBe(400);
    expect(mockExpose).not.toHaveBeenCalled();
  });

  test("400 on unknown action", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", port: 5173, action: "frobnicate" } }));
    expect(res.status).toBe(400);
  });

  test("400 on a bad port for expose", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", port: 0, action: "expose" } }));
    expect(res.status).toBe(400);
    expect(mockExpose).not.toHaveBeenCalled();
  });

  test("400 on a port above 65535 for expose", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", port: 70000, action: "expose" } }));
    expect(res.status).toBe(400);
    expect(mockExpose).not.toHaveBeenCalled();
  });

  test("ignore is a non-action: 200, never exposes", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", action: "ignore" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "ignore" });
    expect(mockExpose).not.toHaveBeenCalled();
  });

  test("expose calls exposeDetectedPort with the SESSION user (requester-scoped)", async () => {
    const res = await run(
      // A spoofed userId in the body MUST be ignored.
      makeEvent({ body: { conversationId: "c1", port: 5173, action: "expose", userId: "attacker" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, previewId: "pid26", code: "code123" });
    expect(mockExpose).toHaveBeenCalledWith({ userId: "session-user", conversationId: "c1", port: 5173 });
    expect(mockSetAlways).not.toHaveBeenCalled();
  });

  test("always-expose sets the pref THEN exposes", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", port: 5173, action: "always-expose" } }));
    expect(res.status).toBe(200);
    expect(mockSetAlways).toHaveBeenCalledWith("c1", "session-user");
    expect(mockExpose).toHaveBeenCalledWith({ userId: "session-user", conversationId: "c1", port: 5173 });
  });

  test("disable-always clears the pref + does not expose", async () => {
    const res = await run(makeEvent({ body: { conversationId: "c1", action: "disable-always" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "disable-always" });
    expect(mockClearAlways).toHaveBeenCalledWith("c1");
    expect(mockExpose).not.toHaveBeenCalled();
  });
});
