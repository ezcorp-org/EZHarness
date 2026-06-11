/**
 * Server-handler unit tests for /api/runtime-events/+server.ts.
 *
 * Returns a Server-Sent Events stream. Only the auth/scope gates and
 * the response-shape (content-type + headers) are asserted — the stream
 * itself subscribes to the runtime bus and is integration territory.
 */

import { test, expect, describe, vi } from "vitest";

const { busOn } = vi.hoisted(() => ({
  busOn: vi.fn((_event: string, _handler: (data: unknown) => void) => () => undefined),
}));

vi.mock("$lib/server/context", () => ({
  getBus: () => ({
    on: busOn,
  }),
}));
vi.mock("$server/db/queries/conversations", () => ({
  getConversation: vi.fn(async () => undefined),
}));

const { GET } = await import("../routes/api/runtime-events/+server");
const { BUS_EVENTS } = await import("../routes/api/runtime-events/bus-events");

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

  // Regression net (Daily Briefing Phase 2 fix loop): the briefing runner
  // emits `conversation:created` and the SSE filter authorizes it, but the
  // endpoint only forwards events in BUS_EVENTS — Phase 2 shipped with the
  // event missing from that array, so live delivery was dead in production
  // while the e2e mock emitter kept the specs green. Pin both the array
  // membership AND that the handler actually subscribes every listed event,
  // so the next direct-carrier event can't silently miss the pipe.
  test("BUS_EVENTS carries conversation:created and GET subscribes every listed event", async () => {
    expect(BUS_EVENTS).toContain("conversation:created");

    busOn.mockClear();
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);

    const subscribed = busOn.mock.calls.map((call) => call[0]);
    expect(new Set(subscribed)).toEqual(new Set(BUS_EVENTS));
    expect(subscribed).toContain("conversation:created");

    // Tear the stream down so the heartbeat interval and bus
    // subscriptions don't leak into other tests.
    await res.body!.cancel();
  });
});
