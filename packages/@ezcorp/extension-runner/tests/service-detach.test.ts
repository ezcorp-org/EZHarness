import { expect, test } from "bun:test";
import { request as httpRequest, type ClientRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import { startRunnerService, type RunnerService, type RunnerServiceOptions } from "../src/service";
import { executionLimits } from "../src/core";

const TOKEN = "test-service-credential-32-bytes-minimum";
/** Short enough that a whole disconnect matrix runs inside one test budget. */
const POLL_MS = 150;
/**
 * Used only by the cases that must observe a lease expiry. Long enough that no
 * amount of setup can exhaust it first: a pre-drop assertion must never depend
 * on how fast the host got through a dozen Unix round trips.
 */
const LEASE_MS = 3_000;
/** The default everywhere else: no case that is not about the lease can reach it. */
const UNREACHABLE_LEASE_MS = 300_000;

/** Every client-side close a host can perform on its event stream. */
const DROPS = ["request.abort", "request.destroy", "socket.end", "socket.destroy"] as const;
type Drop = (typeof DROPS)[number];

interface Harness {
  service: RunnerService;
  socketPath: string;
  /** Emit one worker notification, as a running guest would. */
  notify(workerId: string, method: string, params: unknown): void;
  /** Raise one reverse call from the worker to its host. */
  reverse(workerId: string, method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

async function startHarness(overrides: Partial<RunnerServiceOptions> = {}): Promise<Harness> {
  const root = await mkdtemp("/tmp/ez-w01f-");
  const socketPath = join(root, "runner.sock");
  const notifiers = new Map<string, Set<(method: string, params: unknown) => void>>();
  const reversers = new Map<string, (method: string, params: unknown) => Promise<unknown>>();
  const runner = {
    start: async (input: StartRequest, reverseRpc: (method: string, params: unknown) => Promise<unknown>) => {
      const listeners = new Set<(method: string, params: unknown) => void>();
      notifiers.set(input.workerId, listeners);
      reversers.set(input.workerId, reverseRpc);
      const execution: RunnerExecution = { workerId: input.workerId, request: async () => null, close: async () => {}, onNotification: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      return execution;
    },
    cancel: async () => {},
    inspect: async (id: string) => ({ id, state: "running", diagnostics: [] }),
  } as unknown as Runner;
  const service = await startRunnerService({ runner, socketPath, token: TOKEN, allowedUid: process.getuid!(), eventPollTimeoutMs: POLL_MS, attachmentLeaseMs: UNREACHABLE_LEASE_MS, ...overrides });
  return {
    service,
    socketPath,
    notify: (workerId, method, params) => { for (const listener of notifiers.get(workerId) ?? []) listener(method, params); },
    reverse: (workerId, method, params) => reversers.get(workerId)!(method, params),
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

interface Answer { status: number; body: Record<string, unknown> }

function call(socketPath: string, path: string, data: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const outgoing = httpRequest({ socketPath, path, method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => { try { resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** Open a /v4/events poll and hand back the request once its bytes left the client. */
function openEventStream(socketPath: string, workerId: string): Promise<ClientRequest> {
  return new Promise(resolve => {
    const body = JSON.stringify({ workerId });
    const outgoing = httpRequest({ socketPath, path: "/v4/events", method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, incoming => { incoming.on("data", () => {}); incoming.on("error", () => {}); });
    outgoing.on("error", () => {});
    outgoing.end(body, () => resolve(outgoing));
  });
}

function dropEventStream(poll: ClientRequest, drop: Drop): void {
  if (drop === "request.abort") (poll as unknown as { abort(): void }).abort();
  else if (drop === "request.destroy") poll.destroy();
  else if (drop === "socket.end") poll.socket?.end();
  else poll.socket?.destroy();
}

/** Await an observed service state. The enclosing test budget is the only bound. */
async function until(observed: () => boolean): Promise<void> { while (!observed()) await Bun.sleep(1); }

/** Handle a reverse call's outcome now, so a failing assertion elsewhere cannot leave it unhandled. */
function settled<Value>(promise: Promise<Value>): Promise<{ resolved: Value } | { rejected: string }> {
  return promise.then(resolved => ({ resolved }), error => ({ rejected: error instanceof Error ? error.message : String(error) }));
}

function startBody(workerId: string): Record<string, unknown> {
  return { workerId, artifactDigest: "a".repeat(64), context: { workerId, invocationId: "invocation", releaseId: "release", principalId: "user", scopeId: "scope", token: "capability", deadline: Date.now() + 600_000 }, limits: { ...executionLimits, timeoutMs: 600_000 } };
}

async function startAndAttach(harness: Harness, workerId: string): Promise<void> {
  expect((await call(harness.socketPath, "/v4/start", startBody(workerId))).status).toBe(200);
  expect((await call(harness.socketPath, "/v4/attach", { workerId })).status).toBe(200);
}

test("every host disconnect form releases the worker attachment and a replacement host attaches again", async () => {
  for (const drop of DROPS) {
    // socket.end() raises no abort on this runtime, so this table needs a lease.
    const harness = await startHarness({ attachmentLeaseMs: LEASE_MS });
    try {
      await startAndAttach(harness, "worker");
      expect(harness.service.attachments()).toEqual(["worker"]);

      const poll = await openEventStream(harness.socketPath, "worker");
      dropEventStream(poll, drop);
      await until(() => harness.service.attachments().length === 0);

      expect(harness.service.attachments()).toEqual([]);
      const replacement = await call(harness.socketPath, "/v4/attach", { workerId: "worker" });
      expect(replacement.status).toBe(200);
      expect(replacement.body).toEqual({ workerId: "worker" });
      expect(harness.service.attachments()).toEqual(["worker"]);
    } finally { await harness.close(); }
  }
}, 30_000);

test("a dropped connection releases the attachment from the runtime's own signal, never from the lease", async () => {
  // The lease here is five minutes: nothing in this test can reach it, so a
  // release inside the test budget can only have come from Bun's abort signal.
  const harness = await startHarness({ attachmentLeaseMs: UNREACHABLE_LEASE_MS });
  try {
    await startAndAttach(harness, "worker");
    // While one host holds the stream a second is refused. This lives here,
    // under a lease that cannot fire, so the assertion tests exclusivity and
    // never how fast the box answered.
    expect((await call(harness.socketPath, "/v4/attach", { workerId: "worker" })).status).toBe(400);

    const poll = await openEventStream(harness.socketPath, "worker");
    dropEventStream(poll, "request.destroy");
    await until(() => harness.service.attachments().length === 0);
    expect(harness.service.attachments()).toEqual([]);
    expect((await call(harness.socketPath, "/v4/attach", { workerId: "worker" })).status).toBe(200);
  } finally { await harness.close(); }
}, 30_000);

test("a host that half-closes and stops collecting is released within one attachment lease", async () => {
  // Measured on Bun 1.3.14: a half-close with the client still reading raises
  // no abort, so the lease is the only mechanism that can release this one.
  const harness = await startHarness({ attachmentLeaseMs: LEASE_MS });
  try {
    await startAndAttach(harness, "worker");
    const poll = await openEventStream(harness.socketPath, "worker");
    dropEventStream(poll, "socket.end");
    await until(() => harness.service.attachments().length === 0);
    expect(harness.service.attachments()).toEqual([]);
    // The worker itself is untouched: it still answers and still accepts a host.
    expect((await call(harness.socketPath, "/v4/inspect", { id: "worker" })).body).toMatchObject({ id: "worker", state: "running" });
    expect((await call(harness.socketPath, "/v4/attach", { workerId: "worker" })).status).toBe(200);
  } finally { await harness.close(); }
}, 30_000);

test("one host's disconnect never releases another worker's attachment", async () => {
  const harness = await startHarness({ attachmentLeaseMs: UNREACHABLE_LEASE_MS });
  try {
    await startAndAttach(harness, "leaving");
    await startAndAttach(harness, "staying");
    expect(harness.service.attachments().sort()).toEqual(["leaving", "staying"]);

    const leaving = await openEventStream(harness.socketPath, "leaving");
    const staying = call(harness.socketPath, "/v4/events", { workerId: "staying" });
    dropEventStream(leaving, "request.destroy");
    await until(() => !harness.service.attachments().includes("leaving"));

    expect(harness.service.attachments()).toEqual(["staying"]);
    // The surviving host's own stream still completes and still carries events.
    expect((await staying).status).toBe(200);
    harness.notify("staying", "changed", { key: "value" });
    const collected = await call(harness.socketPath, "/v4/events", { workerId: "staying" });
    expect(collected.body).toEqual({ events: [{ method: "changed", params: { key: "value" } }] });
    expect(harness.service.attachments()).toEqual(["staying"]);
  } finally { await harness.close(); }
}, 30_000);

test("a process whose hosts all disconnect holds no attachment afterwards", async () => {
  const harness = await startHarness({ attachmentLeaseMs: LEASE_MS });
  const workers = ["alpha", "beta", "gamma", "delta"];
  try {
    for (const workerId of workers) await startAndAttach(harness, workerId);
    expect(harness.service.attachments().sort()).toEqual([...workers].sort());

    const polls = await Promise.all(workers.map(workerId => openEventStream(harness.socketPath, workerId)));
    for (const [index, poll] of polls.entries()) dropEventStream(poll, DROPS[index % DROPS.length]!);
    await until(() => harness.service.attachments().length === 0);

    expect(harness.service.attachments()).toEqual([]);
    for (const workerId of workers) expect((await call(harness.socketPath, "/v4/attach", { workerId })).status).toBe(200);
    expect(harness.service.attachments().sort()).toEqual([...workers].sort());
  } finally { await harness.close(); }
}, 30_000);

test("a released attachment keeps every queued reverse call and notification for the replacement host", async () => {
  const harness = await startHarness();
  try {
    await startAndAttach(harness, "worker");
    const poll = await openEventStream(harness.socketPath, "worker");
    dropEventStream(poll, "socket.destroy");
    await until(() => harness.service.attachments().length === 0);

    const answered = settled(harness.reverse("worker", "storage.get", { key: "hello" }));
    harness.notify("worker", "changed", { key: "updated" });
    expect((await call(harness.socketPath, "/v4/attach", { workerId: "worker" })).status).toBe(200);

    const collected = await call(harness.socketPath, "/v4/events", { workerId: "worker" });
    const events = (collected.body as { events: { id?: string; method: string; params: unknown }[] }).events;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ method: "storage.get", params: { key: "hello" } });
    expect(typeof events[0]!.id).toBe("string");
    expect(events[1]).toEqual({ method: "changed", params: { key: "updated" } });

    expect((await call(harness.socketPath, "/v4/reply", { workerId: "worker", id: events[0]!.id, result: { value: "world" } })).status).toBe(200);
    expect(await answered).toEqual({ resolved: { value: "world" } });
  } finally { await harness.close(); }
}, 30_000);

test("a host busy with a reverse call is never evicted while it still owes a reply", async () => {
  const harness = await startHarness({ attachmentLeaseMs: LEASE_MS });
  try {
    await startAndAttach(harness, "worker");
    const answered = settled(harness.reverse("worker", "slow.work", { size: 1 }));
    const collected = await call(harness.socketPath, "/v4/events", { workerId: "worker" });
    const events = (collected.body as { events: { id?: string }[] }).events;
    expect(events).toHaveLength(1);
    // Hold the call for longer than the lease, as a real host handling slow
    // work does. The lease must re-arm while a reply is still owed, because
    // that call already carries its own timeout.
    await Bun.sleep(LEASE_MS * 2);
    expect(harness.service.attachments()).toEqual(["worker"]);

    expect((await call(harness.socketPath, "/v4/reply", { workerId: "worker", id: events[0]!.id, result: "done" })).status).toBe(200);
    expect(await answered).toEqual({ resolved: "done" });
    // The stream still belongs to the same host: a replacement is refused and
    // the host's own next poll is served.
    expect((await call(harness.socketPath, "/v4/attach", { workerId: "worker" })).status).toBe(400);
    expect((await call(harness.socketPath, "/v4/events", { workerId: "worker" })).body).toEqual({ events: [] });
  } finally { await harness.close(); }
}, 30_000);

test("an event poll window or attachment lease outside its declared range is refused by name", async () => {
  const root = await mkdtemp("/tmp/ez-w01f-");
  const socketPath = join(root, "runner.sock");
  const runner = { inspect: async () => { throw new Error("must never start"); } } as unknown as Runner;
  const base = { runner, socketPath, token: TOKEN, allowedUid: process.getuid!() };
  try {
    for (const eventPollTimeoutMs of [99, 300_001, 1.5]) await expect(startRunnerService({ ...base, eventPollTimeoutMs })).rejects.toThrow("Runner event poll window must be between 100 milliseconds and five minutes");
    for (const attachmentLeaseMs of [POLL_MS, POLL_MS - 1, 600_001, 1.5]) await expect(startRunnerService({ ...base, eventPollTimeoutMs: POLL_MS, attachmentLeaseMs })).rejects.toThrow("Runner attachment lease must outlast one event poll and stay under ten minutes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized headers, an absent body and an unknown endpoint are each refused", async () => {
  const harness = await startHarness();
  try {
    const oversized = await call(harness.socketPath, "/v4/inspect", { id: "worker" }, { "x-padding": "p".repeat(4096) });
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({ error: { code: "request_limit", message: "Runner request headers exceed policy" } });

    const absent = await new Promise<Answer>((resolve, reject) => {
      const outgoing = httpRequest({ socketPath: harness.socketPath, path: "/v4/inspect", method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "content-length": 0 } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        incoming.on("error", reject);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(absent.status).toBe(400);
    expect(absent.body).toMatchObject({ error: { code: "invalid_request" } });

    const unknown = await call(harness.socketPath, "/v4/nowhere", {});
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: { code: "unknown_method", message: "Unknown runner endpoint" } });
  } finally { await harness.close(); }
}, 15_000);
