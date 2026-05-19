/**
 * Server-handler unit tests for /api/runtime-events/+server.ts.
 *
 * Returns a Server-Sent Events stream. Only the auth/scope gates and
 * the response-shape (content-type + headers) are asserted — the stream
 * itself subscribes to the runtime bus and is integration territory.
 */

import { test, expect, describe, vi } from "vitest";

vi.mock("$lib/server/context", () => ({
  getBus: () => ({
    on: vi.fn(() => () => undefined),
  }),
}));
vi.mock("$server/db/queries/conversations", () => ({
  getConversation: vi.fn(async () => undefined),
}));

const { GET } = await import("../routes/api/runtime-events/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  query?: Record<string, string>;
}) {
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  const url = "http://localhost/api/runtime-events" + qs;
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    request: new Request(url),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/runtime-events", () => {
  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns an SSE response with the correct content-type", async () => {
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    // `Content-Encoding: identity` defeats compression middleware that
    // would otherwise buffer SSE frames until a block boundary. Pair it
    // with `no-transform` so caching proxies don't override.
    expect(res.headers.get("content-encoding")).toBe("identity");
    // Stream's start/cancel lifecycle is exercised in integration tests;
    // the bus is fully mocked here so no cleanup is needed.
    expect(res.body).toBeInstanceOf(ReadableStream);
  });
});
