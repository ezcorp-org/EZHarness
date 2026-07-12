/**
 * Server-handler unit tests for /api/runtime-events/+server.ts.
 *
 * Returns a Server-Sent Events stream. Only the auth/scope gates and
 * the response-shape (content-type + headers) are asserted — the stream
 * itself subscribes to the runtime bus and is integration territory.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const { busOn, getConversationMock, getRunConversationIdMock, getRunOwnershipMock } = vi.hoisted(() => ({
  busOn: vi.fn((_event: string, _handler: (data: unknown) => void) => () => undefined),
  getConversationMock: vi.fn(async (_id: string): Promise<unknown> => undefined),
  getRunConversationIdMock: vi.fn(async (_id: string): Promise<string | undefined> => undefined),
  getRunOwnershipMock: vi.fn(async (_id: string) => ({ userId: null, conversationId: null })),
}));

vi.mock("$lib/server/context", () => ({
  getBus: () => ({
    on: busOn,
  }),
  // Wave 0: the route builds a runId→scope resolver from the executor
  // for the fail-closed scoped-runtime-event SSE filter.
  getExecutor: () => ({
    getRunConversationId: getRunConversationIdMock,
    getRunOwnership: getRunOwnershipMock,
  }),
}));
vi.mock("$server/db/queries/conversations", () => ({
  getConversation: getConversationMock,
}));

const { GET } = await import("../routes/api/runtime-events/+server");
const { BUS_EVENTS } = await import("../routes/api/runtime-events/bus-events");
const { __resetSseResumeBufferForTests } = await import(
  "$lib/server/sse-resume-buffer"
);

// The resume buffer is a process singleton (one lazy bus subscription that
// survives connect/disconnect). Reset it before each test so every GET is a
// clean "first connection" — the recorder re-subscribes the mocked bus, which
// the subscribe-every-event + run:token cases assert on.
beforeEach(() => {
  __resetSseResumeBufferForTests();
});

/** Read `n` SSE chunks from a response body and return the concatenated text. */
async function readChunks(res: Response, n: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (let i = 0; i < n; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  await reader.cancel();
  return out;
}

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

  // Wave 0 (orchestration-upgrade): run:token used to broadcast raw
  // streamed LLM text to every authenticated subscriber. This pins the
  // full route-level path: bus handler → shouldDeliverEvent (real
  // filter module) → executor-backed run-scope resolution → frame is
  // written ONLY for the run's conversation owner.
  test("run:token frames reach only the run's conversation owner", async () => {
    const { __clearMembershipCacheForTests, __clearRunScopeCacheForTests } = await import(
      "$server/runtime/sse-conversation-filter"
    );
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();

    getRunConversationIdMock.mockImplementation(async (runId: string) =>
      runId === "run-owned" ? "conv-owned" : runId === "run-foreign" ? "conv-foreign" : undefined,
    );
    getConversationMock.mockImplementation(async (id: string) =>
      id === "conv-owned" ? { userId: "u1" } : id === "conv-foreign" ? { userId: "someone-else" } : null,
    );

    busOn.mockClear();
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);

    const tokenHandler = busOn.mock.calls.find((call) => call[0] === "run:token")?.[1] as
      | ((data: unknown) => void)
      | undefined;
    expect(tokenHandler).toBeDefined();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const readFrame = async (): Promise<string> => {
      const { value } = await reader.read();
      return decoder.decode(value);
    };

    // Priming frame arrives first.
    expect(await readFrame()).toContain(": connected");

    // A foreign run's token must be dropped; the owned run's token must
    // arrive. Emitting foreign-then-owned proves the drop: microtask
    // delivery is FIFO per handler, so if the foreign frame had been
    // written it would precede the owned one.
    tokenHandler!({ runId: "run-foreign", token: "other-users-secret", kind: "text" });
    tokenHandler!({ runId: "run-owned", token: "my-own-token", kind: "text" });

    const frame = await readFrame();
    expect(frame).toContain("my-own-token");
    expect(frame).not.toContain("other-users-secret");

    await reader.cancel();
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();
  });
});

// C3: reconnecting SSE clients replay events fired during the gap via
// Last-Event-ID, through the SAME per-subscriber filter as live delivery.
describe("GET /api/runtime-events — Last-Event-ID resume (C3)", () => {
  test("replays buffered events to the OWNER on reconnect and drops them for a non-owner", async () => {
    const { __clearMembershipCacheForTests, __clearRunScopeCacheForTests } =
      await import("$server/runtime/sse-conversation-filter");
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();

    getRunConversationIdMock.mockImplementation(async (runId: string) =>
      runId === "run-owned"
        ? "conv-owned"
        : runId === "run-u2"
          ? "conv-u2"
          : undefined,
    );
    getConversationMock.mockImplementation(async (id: string) =>
      id === "conv-owned"
        ? { userId: "u1" }
        : id === "conv-u2"
          ? { userId: "u2" }
          : null,
    );

    busOn.mockClear();
    // Connection #1 (owner u1) primes the recorder's bus subscription so
    // events buffer even while this is the only client.
    const res1 = await GET(makeEvent({ locals: authedUser }));
    const emit = busOn.mock.calls.find((c) => c[0] === "run:token")?.[1] as
      | ((data: unknown) => void)
      | undefined;
    expect(emit).toBeDefined();

    // Two events fire "while disconnected" — buffered as ids 1 and 2.
    emit!({ runId: "run-owned", token: "gap-token-1", kind: "text" });
    emit!({ runId: "run-owned", token: "gap-token-2", kind: "text" });
    await res1.body!.cancel();

    // Owner u1 reconnects from cursor 0 → both replayed, each carrying its id.
    const res2 = await GET(
      makeEvent({ locals: authedUser, query: { lastEventId: "0" } }),
    );
    const owned = await readChunks(res2, 3); // priming + 2 replayed frames
    expect(owned).toContain("gap-token-1");
    expect(owned).toContain("gap-token-2");
    expect(owned).toContain("id: 1");
    expect(owned).toContain("id: 2");

    // A different user u2 reconnects from cursor 0 → both dropped. Prove it via
    // ordering: a live u2-owned event (id 3) is emitted AFTER the replay is
    // scheduled, and it is the first frame after priming — the replayed u1
    // events never reach u2.
    const u2 = { user: { id: "u2", email: "u2@x", name: "u2", role: "user" } };
    const res3 = await GET(
      makeEvent({ locals: u2, query: { lastEventId: "0" } }),
    );
    emit!({ runId: "run-u2", token: "u2-live-token", kind: "text" });
    const foreign = await readChunks(res3, 2); // priming + the live u2 frame
    expect(foreign).toContain("u2-live-token");
    expect(foreign).not.toContain("gap-token-1");
    expect(foreign).not.toContain("gap-token-2");

    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();
  });

  test("no cursor → no replay (a fresh connection only sees live events)", async () => {
    const { __clearMembershipCacheForTests, __clearRunScopeCacheForTests } =
      await import("$server/runtime/sse-conversation-filter");
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();

    getRunConversationIdMock.mockImplementation(async (runId: string) =>
      runId === "run-owned" ? "conv-owned" : undefined,
    );
    getConversationMock.mockImplementation(async (id: string) =>
      id === "conv-owned" ? { userId: "u1" } : null,
    );

    busOn.mockClear();
    const res1 = await GET(makeEvent({ locals: authedUser }));
    const emit = busOn.mock.calls.find((c) => c[0] === "run:token")?.[1] as
      | ((data: unknown) => void)
      | undefined;
    emit!({ runId: "run-owned", token: "buffered-before", kind: "text" });
    await res1.body!.cancel();

    // Reconnect WITHOUT a cursor: the buffered event is not replayed; only the
    // next live event (id 2) reaches the client.
    const res2 = await GET(makeEvent({ locals: authedUser }));
    emit!({ runId: "run-owned", token: "live-after", kind: "text" });
    const frames = await readChunks(res2, 2); // priming + the live frame
    expect(frames).toContain("live-after");
    expect(frames).not.toContain("buffered-before");

    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();
  });
});

// Wave5 0.5: the exposed `id:` is a DENSE per-subscriber-scope sequence, never
// the process-global ring counter, so its gaps can't leak how much activity
// OTHER users generate — while Last-Event-ID resume keeps working.
describe("GET /api/runtime-events — per-scope id numbering (Wave5 0.5)", () => {
  async function frameReader(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    return {
      next: async () => decoder.decode((await reader.read()).value),
      cancel: () => reader.cancel(),
    };
  }

  test("a foreign (dropped) event does NOT bump this subscriber's id (side-channel closed)", async () => {
    const { __clearMembershipCacheForTests, __clearRunScopeCacheForTests } =
      await import("$server/runtime/sse-conversation-filter");
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();

    getRunConversationIdMock.mockImplementation(async (runId: string) =>
      runId === "run-owned" ? "conv-owned" : runId === "run-u2" ? "conv-u2" : undefined,
    );
    getConversationMock.mockImplementation(async (id: string) =>
      id === "conv-owned" ? { userId: "u1" } : id === "conv-u2" ? { userId: "u2" } : null,
    );

    busOn.mockClear();
    const res = await GET(makeEvent({ locals: authedUser }));
    const emit = busOn.mock.calls.find((c) => c[0] === "run:token")?.[1] as
      | ((data: unknown) => void)
      | undefined;
    expect(emit).toBeDefined();

    const r = await frameReader(res);
    expect(await r.next()).toContain(": connected"); // priming

    // global 1 (owned) → id 1.
    emit!({ runId: "run-owned", token: "own-1", kind: "text" });
    const f1 = await r.next();
    expect(f1).toContain("own-1");
    expect(f1).toContain("id: 1");

    // global 2 is a FOREIGN u2 event (dropped for u1 — no frame), yet it
    // advances the process-global ring counter. global 3 (owned) follows.
    emit!({ runId: "run-u2", token: "foreign-secret", kind: "text" });
    emit!({ runId: "run-owned", token: "own-3", kind: "text" });
    const f3 = await r.next();
    expect(f3).toContain("own-3");
    expect(f3).not.toContain("foreign-secret");
    // DENSE: id is 2, NOT 3 — the gap the global counter would have shown
    // (revealing the foreign event happened) is gone.
    expect(f3).toContain("id: 2");
    expect(f3).not.toContain("id: 3");

    await r.cancel();
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();
  });

  test("Last-Event-ID resume still works across an interleaved foreign event", async () => {
    const { __clearMembershipCacheForTests, __clearRunScopeCacheForTests } =
      await import("$server/runtime/sse-conversation-filter");
    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();

    getRunConversationIdMock.mockImplementation(async (runId: string) =>
      runId === "run-owned" ? "conv-owned" : runId === "run-u2" ? "conv-u2" : undefined,
    );
    getConversationMock.mockImplementation(async (id: string) =>
      id === "conv-owned" ? { userId: "u1" } : id === "conv-u2" ? { userId: "u2" } : null,
    );

    busOn.mockClear();
    const res1 = await GET(makeEvent({ locals: authedUser }));
    const emit = busOn.mock.calls.find((c) => c[0] === "run:token")?.[1] as
      | ((data: unknown) => void)
      | undefined;
    const r1 = await frameReader(res1);
    expect(await r1.next()).toContain(": connected");

    // u1 sees own-a (global 1 → id 1); a foreign event (global 2) is dropped;
    // u1 sees own-b (global 3 → id 2). u1's last seen per-scope id is 2.
    emit!({ runId: "run-owned", token: "own-a", kind: "text" });
    expect(await r1.next()).toContain("id: 1");
    emit!({ runId: "run-u2", token: "foreign", kind: "text" });
    emit!({ runId: "run-owned", token: "own-b", kind: "text" });
    expect(await r1.next()).toContain("id: 2");
    await r1.cancel();

    // A new owned event fires while u1 is "disconnected" (buffered, global 4).
    emit!({ runId: "run-owned", token: "own-c-missed", kind: "text" });

    // u1 reconnects presenting its per-scope cursor 2 → translated to global 3
    // → only global 4 (own-c-missed) is replayed, as the NEXT dense id (3).
    // The already-seen own-a/own-b are NOT re-delivered.
    const res2 = await GET(
      makeEvent({ locals: authedUser, query: { lastEventId: "2" } }),
    );
    const resumed = await readChunks(res2, 2); // priming + the one missed frame
    expect(resumed).toContain("own-c-missed");
    expect(resumed).toContain("id: 3");
    expect(resumed).not.toContain("own-a");
    expect(resumed).not.toContain("own-b");

    __clearMembershipCacheForTests();
    __clearRunScopeCacheForTests();
  });
});
