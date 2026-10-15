/**
 * What the host's launch routes say when they cannot answer with a result, and
 * where they write it (W01h).
 *
 * Every refusal is a typed body the product can act on and a line in the host's
 * own log. The one silent case is a result window that closed on a running
 * guest: that is the long poll working, and the product simply asks again.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryPrivateRequest } from "../private-https";
import { factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, factoryLaunchPeerTenants } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import { FactoryAttemptRuntimeError, factoryAttemptLaunchIntentToWire, snapshotIntent } from "./attempt-wire";
import {
  FACTORY_HOST_ATTACH_PATH,
  FACTORY_HOST_LAUNCH_PATH,
  FACTORY_HOST_RESULT_PATH,
  FACTORY_HOST_RESULT_WINDOW_MS,
  createFactoryHostLaunchRouteHandler,
  type FactoryHostLaunchReport,
  type FactoryHostLaunchSupervisor,
} from "./host-launch-service";
import { FactoryHostGuestTenants } from "./host-peer-tenants";

const hostId = factoryLaunchLease.hostId;
const request = factoryLaunchRequest({ attemptId: "attempt-route" });
const intent = snapshotIntent(request, factoryLaunchLease, factoryLaunchPackage(request));
const wire = Buffer.from(JSON.stringify({ intent: factoryAttemptLaunchIntentToWire(intent) }));

function call(path: string, peerIdentity = "tenant-a"): FactoryPrivateRequest {
  return { peerIdentity, method: "POST", path, headers: { "x-ezcorp-factory-version": "1", "content-type": "application/json" }, body: wire };
}

function body(response: { body: Uint8Array }): unknown {
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}

/** A supervisor whose every answer the case chooses; a pending answer lasts until the route's own window ends it. */
function supervisor(result: (signal: AbortSignal) => Promise<FactoryRunnerResult>): FactoryHostLaunchSupervisor {
  const handle = { disposition: "started" as const, workerId: intent.workerId, invocationId: intent.invocationId };
  return {
    launch: (_intent, signal) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("start still running")), { once: true }); void resolve; }),
    attach: async () => handle,
    result: async (_intent, signal) => result(signal),
  };
}

const untilAborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("window ended")), { once: true }); });

function route(result: (signal: AbortSignal) => Promise<FactoryRunnerResult>, windows: { launchTimeoutMs?: number; resultTimeoutMs?: number } = {}) {
  const reports: FactoryHostLaunchReport[] = [];
  const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor: supervisor(result), report: (entry) => { reports.push(entry); }, ...windows });
  return { handle, reports };
}

const named = { attemptId: intent.request.authority.attemptId, workerId: intent.workerId };

describe("the result route", () => {
  test("answers a settled guest's result and writes nothing to the log", async () => {
    const completed = factoryLaunchCompletedResult("route");
    const { handle, reports } = route(async () => completed);
    const response = await handle(call(FACTORY_HOST_RESULT_PATH));
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ result: completed });
    expect(reports).toEqual([]);
  });

  test("a window that closes on a running guest is host_timeout and is not logged", async () => {
    const { handle, reports } = route(untilAborted, { resultTimeoutMs: 20 });
    const response = await handle(call(FACTORY_HOST_RESULT_PATH));
    expect(response.status).toBe(504);
    expect(body(response)).toEqual({ error: "host_timeout" });
    expect(reports).toEqual([]);
  });

  test("a guest that exited is guest_exited with its detail, in the reply and in the log", async () => {
    const detail = "extension runner process exited with code 137; state failed";
    const { handle, reports } = route(async () => { throw new FactoryAttemptRuntimeError("guest_exited", detail); });
    const response = await handle(call(FACTORY_HOST_RESULT_PATH));
    expect(response.status).toBe(502);
    expect(body(response)).toEqual({ error: "guest_exited", detail });
    expect(reports).toEqual([{ path: FACTORY_HOST_RESULT_PATH, status: 502, error: "guest_exited", detail, ...named }]);
  });

  test("an attempt the host holds no record of is attempt_uncertain, logged with its identities", async () => {
    const { handle, reports } = route(async () => { throw new FactoryAttemptRuntimeError("attempt_unknown", "This host is not running that attempt."); });
    const response = await handle(call(FACTORY_HOST_RESULT_PATH));
    expect(response.status).toBe(409);
    expect(body(response)).toEqual({ error: "attempt_uncertain" });
    expect(reports).toEqual([{ path: FACTORY_HOST_RESULT_PATH, status: 409, error: "attempt_uncertain", detail: "This host is not running that attempt.", ...named }]);
  });

  test("an unexpected fault is host_failed, and its message reaches the log, never the reply", async () => {
    const { handle, reports } = route(async () => { throw new Error("runner socket reset"); });
    const response = await handle(call(FACTORY_HOST_RESULT_PATH));
    expect(response.status).toBe(500);
    expect(body(response)).toEqual({ error: "host_failed" });
    expect(reports).toEqual([{ path: FACTORY_HOST_RESULT_PATH, status: 500, error: "host_failed", detail: "runner socket reset", ...named }]);
  });

  test("a result read is bounded by the long-poll window by default", () => {
    expect(FACTORY_HOST_RESULT_WINDOW_MS).toBe(20_000);
  });
});

describe("the launch and attach routes", () => {
  test("a launch that outlives its window is host_timeout, and that one is logged", async () => {
    const { handle, reports } = route(untilAborted, { launchTimeoutMs: 20 });
    const response = await handle(call(FACTORY_HOST_LAUNCH_PATH));
    expect(response.status).toBe(504);
    expect(reports).toEqual([{ path: FACTORY_HOST_LAUNCH_PATH, status: 504, error: "host_timeout", detail: "start still running", ...named }]);
  });

  test("an attach answers the host's disposition", async () => {
    const { handle } = route(untilAborted);
    const response = await handle(call(FACTORY_HOST_ATTACH_PATH));
    expect(body(response)).toEqual({ disposition: "started", workerId: intent.workerId, invocationId: intent.invocationId });
  });

  test("an unknown peer is refused and logged without any attempt identity", async () => {
    const { handle, reports } = route(untilAborted);
    const response = await handle(call(FACTORY_HOST_RESULT_PATH, "stranger"));
    expect(response.status).toBe(401);
    expect(reports).toEqual([{ path: FACTORY_HOST_RESULT_PATH, status: 401, error: "unauthorized", detail: "unauthorized" }]);
  });
});

describe("the host's log", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  test("is the process's standard error unless a report is supplied", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    restore = () => spy.mockRestore();
    const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor: supervisor(async () => { throw new FactoryAttemptRuntimeError("guest_exited", "exited 1"); }) });
    expect((await handle(call(FACTORY_HOST_RESULT_PATH))).status).toBe(502);
    expect(lines).toEqual([`[factory-host-launch] ${JSON.stringify({ path: FACTORY_HOST_RESULT_PATH, status: 502, error: "guest_exited", detail: "exited 1", ...named })}`]);
  });
});

describe("each peer drives only its own tenant's guests (W01i)", () => {
  /** A supervisor that counts every call, so a refusal can be shown to happen before any of them. */
  function counting() {
    const calls: string[] = [];
    const handle = { disposition: "started" as const, workerId: intent.workerId, invocationId: intent.invocationId };
    const counted: FactoryHostLaunchSupervisor = {
      launch: async () => { calls.push("launch"); return handle; },
      attach: async () => { calls.push("attach"); return handle; },
      result: async () => { calls.push("result"); return factoryLaunchCompletedResult("tenant"); },
    };
    return { calls, counted };
  }
  const peerTenants = { ...factoryLaunchPeerTenants(), "tenant-b": "tenant-other" };

  for (const path of [FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_RESULT_PATH]) {
    test(`${path}: a peer bound to another tenant is refused forbidden_tenant before the supervisor is called`, async () => {
      const { calls, counted } = counting();
      const guestTenants = new FactoryHostGuestTenants();
      const reports: FactoryHostLaunchReport[] = [];
      const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants, supervisor: counted, guestTenants, report: (entry) => { reports.push(entry); } });
      const response = await handle(call(path, "tenant-b"));
      expect(response.status).toBe(403);
      expect(body(response)).toEqual({ error: "forbidden_tenant" });
      expect(calls).toEqual([]);
      expect(guestTenants.of(intent.workerId)).toBeUndefined();
      expect(reports).toEqual([{ path, status: 403, error: "forbidden_tenant", detail: "forbidden_tenant", ...named }]);
    });

    test(`${path}: the peer bound to the intent's tenant goes through and its guest's tenant is recorded`, async () => {
      const { calls, counted } = counting();
      const guestTenants = new FactoryHostGuestTenants();
      const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants, supervisor: counted, guestTenants, report: () => {} });
      expect((await handle(call(path))).status).toBe(200);
      expect(calls).toEqual([path === FACTORY_HOST_LAUNCH_PATH ? "launch" : path === FACTORY_HOST_ATTACH_PATH ? "attach" : "result"]);
      expect(guestTenants.of(intent.workerId)).toBe(request.authority.tenantId);
    });
  }

  test("an unknown peer stays 401 unauthorized and reaches nothing", async () => {
    const { calls, counted } = counting();
    const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants, supervisor: counted, report: () => {} });
    const response = await handle(call(FACTORY_HOST_LAUNCH_PATH, "tenant-unknown"));
    expect(response.status).toBe(401);
    expect(body(response)).toEqual({ error: "unauthorized" });
    expect(calls).toEqual([]);
  });

  test("a host with no peer bound to a tenant does not start", () => {
    const { counted } = counting();
    for (const broken of [{}, { "tenant-a": "" }] as Readonly<Record<string, string>>[]) {
      expect(() => createFactoryHostLaunchRouteHandler({ hostId, peerTenants: broken, supervisor: counted })).toThrow("authorized peer");
    }
  });
});


describe("the launch route names a device the host does not have (W02d R4)", () => {
  test("a supervisor's device_unavailable is 422 with its detail, in the reply and in the log", async () => {
    const detail = "Device /dev/dri/renderD200 granted to worker w is not present on host h.";
    const reports: FactoryHostLaunchReport[] = [];
    const refusing: FactoryHostLaunchSupervisor = {
      launch: async () => { throw new FactoryAttemptRuntimeError("device_unavailable", detail); },
      attach: async () => { throw new Error("unused"); },
      result: async () => { throw new Error("unused"); },
    };
    const handle = createFactoryHostLaunchRouteHandler({ hostId, peerTenants: factoryLaunchPeerTenants(), supervisor: refusing, report: (entry) => { reports.push(entry); } });
    const response = await handle(call(FACTORY_HOST_LAUNCH_PATH));
    expect(response.status).toBe(422);
    expect(body(response)).toEqual({ error: "device_unavailable", detail });
    expect(reports).toEqual([{ path: FACTORY_HOST_LAUNCH_PATH, status: 422, error: "device_unavailable", detail, ...named }]);
  });
});
