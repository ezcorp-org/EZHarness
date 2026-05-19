/**
 * Phase 48 Wave 2 — GET/POST /api/ez/drafts/[id] + POST .../consume
 *
 * Covers:
 *   GET
 *     - 401 without auth
 *     - 404 when getDraft returns undefined (covers expired/non-existent/
 *       cross-user via the query-layer ownership check)
 *     - 200 + shaped payload when getDraft returns a row
 *     - consumed-but-not-expired draft is still returned with `consumed: true`
 *   POST (body-action shape)
 *     - 401 without auth
 *     - 404 when consumeDraft returns undefined
 *     - 200 + shaped payload on consume
 *     - rejects unknown action with 400
 *     - tolerates empty body (defaults to "consume")
 *   POST .../consume sub-route
 *     - 401 without auth
 *     - 404 when consumeDraft returns undefined
 *     - 200 + minimal payload on consume
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/ez-drafts", () => ({
  getDraft: vi.fn(),
  consumeDraft: vi.fn(),
}));

const { getDraft, consumeDraft } = await import("$server/db/queries/ez-drafts");
const { GET, POST } = await import("../routes/api/ez/drafts/[id]/+server");
const { POST: ConsumePOST } = await import("../routes/api/ez/drafts/[id]/consume/+server");

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "POST";
}) {
  const id = opts.id ?? "draft-1";
  const method = opts.method ?? "GET";
  const href = `http://localhost/api/ez/drafts/${id}`;
  return {
    url: new URL(href),
    params: { id },
    locals: opts.locals ?? {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    request: new Request(href, {
      method,
      headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "U", role: "member" };
const draftRow = {
  id: "draft-1",
  userId: "u1",
  kind: "project",
  payload: { name: "App", path: "/p" },
  createdAt: new Date("2026-04-01T00:00:00Z"),
  expiresAt: new Date("2026-04-02T00:00:00Z"),
  consumedAt: null as Date | null,
};

describe("GET /api/ez/drafts/[id]", () => {
  beforeEach(() => {
    vi.mocked(getDraft).mockReset();
  });

  test("401 without auth, getDraft NOT called", async () => {
    const res = (await GET(makeEvent({}))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(getDraft)).not.toHaveBeenCalled();
  });

  test("404 when draft is missing/expired/cross-user (getDraft returns undefined)", async () => {
    vi.mocked(getDraft).mockResolvedValue(undefined as any);
    const res = (await GET(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/draft/i);
    expect(vi.mocked(getDraft)).toHaveBeenCalledWith("draft-1", "u1");
  });

  test("happy path: 200 + shaped payload, consumed: false", async () => {
    vi.mocked(getDraft).mockResolvedValue({ ...draftRow } as any);
    const res = (await GET(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; kind: string; payload: Record<string, unknown>; consumed: boolean };
    expect(body.id).toBe("draft-1");
    expect(body.kind).toBe("project");
    expect(body.payload).toEqual({ name: "App", path: "/p" });
    expect(body.consumed).toBe(false);
  });

  test("consumed-but-not-expired draft is still returned with consumed: true", async () => {
    vi.mocked(getDraft).mockResolvedValue({
      ...draftRow,
      consumedAt: new Date("2026-04-01T12:00:00Z"),
    } as any);
    const res = (await GET(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consumed: boolean };
    expect(body.consumed).toBe(true);
  });
});

describe("POST /api/ez/drafts/[id] (body-action shape)", () => {
  beforeEach(() => {
    vi.mocked(consumeDraft).mockReset();
  });

  test("401 without auth, consumeDraft NOT called", async () => {
    const res = (await POST(makeEvent({ method: "POST", body: { action: "consume" } }))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(consumeDraft)).not.toHaveBeenCalled();
  });

  test("404 when consumeDraft returns undefined", async () => {
    vi.mocked(consumeDraft).mockResolvedValue(undefined as any);
    const res = (await POST(makeEvent({ method: "POST", locals: { user }, body: { action: "consume" } }))) as Response;
    expect(res.status).toBe(404);
  });

  test("happy path: 200 + payload with consumed: true", async () => {
    vi.mocked(consumeDraft).mockResolvedValue({
      ...draftRow,
      consumedAt: new Date("2026-04-01T12:00:00Z"),
    } as any);
    const res = (await POST(makeEvent({ method: "POST", locals: { user }, body: { action: "consume" } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consumed: boolean };
    expect(body.consumed).toBe(true);
  });

  test("rejects unknown action with 400", async () => {
    const res = (await POST(makeEvent({ method: "POST", locals: { user }, body: { action: "nuke" } }))) as Response;
    expect(res.status).toBe(400);
    expect(vi.mocked(consumeDraft)).not.toHaveBeenCalled();
  });

  test("empty body defaults to consume", async () => {
    vi.mocked(consumeDraft).mockResolvedValue({
      ...draftRow,
      consumedAt: new Date(),
    } as any);
    // Build an event with no body (request.text() returns empty string).
    const evt = {
      url: new URL("http://localhost/api/ez/drafts/draft-1"),
      params: { id: "draft-1" },
      locals: { user },
      cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
      request: new Request("http://localhost/api/ez/drafts/draft-1", { method: "POST" }),
    } as any;
    const res = (await POST(evt)) as Response;
    expect(res.status).toBe(200);
    expect(vi.mocked(consumeDraft)).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/ez/drafts/[id]/consume sub-route", () => {
  beforeEach(() => {
    vi.mocked(consumeDraft).mockReset();
  });

  test("401 without auth", async () => {
    const res = (await ConsumePOST(makeEvent({ method: "POST" }))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(consumeDraft)).not.toHaveBeenCalled();
  });

  test("404 when consumeDraft returns undefined", async () => {
    vi.mocked(consumeDraft).mockResolvedValue(undefined as any);
    const res = (await ConsumePOST(makeEvent({ method: "POST", locals: { user } }))) as Response;
    expect(res.status).toBe(404);
  });

  test("happy path: 200 + minimal payload", async () => {
    vi.mocked(consumeDraft).mockResolvedValue({
      ...draftRow,
      consumedAt: new Date("2026-04-01T12:00:00Z"),
    } as any);
    const res = (await ConsumePOST(makeEvent({ method: "POST", locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; consumed: boolean };
    expect(body.id).toBe("draft-1");
    expect(body.consumed).toBe(true);
    expect(vi.mocked(consumeDraft)).toHaveBeenCalledWith("draft-1", "u1");
  });
});
