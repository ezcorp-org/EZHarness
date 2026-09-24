import { afterEach, expect, mock, test } from "bun:test";

const calls: string[] = [];
let fail = false;
let witnessReady = false;
let verifiedStoreResult = false;
let fixtureReady = true;
const originalRoot = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
afterEach(() => {
  if (originalRoot === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = originalRoot;
});
mock.module("$server/infrastructure/incus-host-live-witness", () => ({
  incusHostLiveWitnessReady: () => witnessReady,
  IncusHostLiveWitness: class {
    constructor(options: { controlProbe: unknown }) {
      calls.push(`witness.construct:${options.controlProbe instanceof ControlProbe}`);
    }
  },
}));
class ControlProbe {
  constructor(config: { cases: Record<string, unknown> }) {
    calls.push(`control.construct:${Object.keys(config.cases).length}`);
  }
}
mock.module("$server/infrastructure/incus-live-control-probes", () => ({ IncusLiveControlProbes: ControlProbe }));
mock.module("$server/infrastructure/incus-live-probe-fixtures", () => ({
  IncusLiveProbeFixtureService: class {
    constructor(options: { rootDirectory: string }) { calls.push(`probe-fixture.construct:${options.rootDirectory}`); }
    async readyConfig(input: { connectionId: string }, operationId: string) {
      calls.push(`probe-fixture.ready:${input.connectionId}:${operationId}`);
      if (!fixtureReady) throw new Error("fixture missing or stale");
      return { cases: { unsupported: {}, missingControl: {}, drift: {}, unqualified: {} } };
    }
  },
}));
mock.module("$server/infrastructure/incus-live-cases", () => ({
  createIncusLiveCaseRunner: (options: { witness: unknown; composeFixtureImageRef?: string }) => {
    calls.push(`runner.construct:${Boolean(options.witness)}:${options.composeFixtureImageRef ?? "missing"}`);
    return async () => {
      calls.push("runner.execute");
      if (verifiedStoreResult) return { cases: [{ caseId: "SP01", status: "passed" }] };
      throw new Error("mock runner must not certify a live case");
    };
  },
}));
const operation = { id: "controller-operation", kind: "CREATE", state: "SUCCEEDED", generation: 1,
  providerOperationId: "provider-operation", errorCode: null, requestPayload: { privateKeyPem: "secret" } };
mock.module("$server/infrastructure/incus-qualification", () => ({
  IncusQualificationStore: class {
    constructor(private readonly deps: { runLiveCases: (scope: unknown, preset: unknown) => Promise<unknown> }) {
      calls.push("store.construct");
    }
    async recordVerified(scope: { connectionId: string }) {
      calls.push(`recordVerified:${scope.connectionId}`);
      await this.deps.runLiveCases(scope, {});
      if (verifiedStoreResult) return { providerId: "incus", connectionId: scope.connectionId,
        presetId: "preset", releaseDigest: "a".repeat(64), verifiedAt: "2026-09-23T00:00:00Z",
        validUntil: "2026-09-24T00:00:00Z", cases: [{ caseId: "SP01", status: "passed" }] };
      throw new Error("mock store must not certify a live case");
    }
  },
  IncusQualificationFixtureService: class {
  async create(scope: { connectionId: string }, id: string) {
    calls.push(`create:${scope.connectionId}:${id}`);
    if (fail) throw new Error("connection credentials secret");
    return operation;
  }
  async status(scope: { connectionId: string }, id: string) {
    calls.push(`status:${scope.connectionId}:${id}`);
    if (fail) throw new Error("connection credentials secret");
    return { fixture: { operationId: id, connectionId: scope.connectionId },
      binding: { id: "fixture-binding", observedState: "STOPPED" }, operation: { id: operation.id } };
  }
  async destroy(scope: { connectionId: string }, id: string) {
    calls.push(`destroy:${scope.connectionId}:${id}`);
    if (fail) throw new Error("connection credentials secret");
    return { ...operation, kind: "DESTROY" };
  }
  async setPower(scope: { connectionId: string }, id: string, desiredState: string, key: string) {
    calls.push(`power:${scope.connectionId}:${id}:${desiredState}:${key}`);
    if (fail) throw new Error("connection credentials secret");
    return { ...operation, kind: desiredState === "running" ? "START" : "STOP" };
  }
} }));

const { POST } = await import("./+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
  presetId: "preset", operationId: "fixture-1" };
function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost",
  contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request("http://localhost/api/infrastructure/incus/qualification", {
    method: "POST", headers: { "content-type": contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }) } as unknown as Parameters<typeof POST>[0];
}

test("fixture actions require a session administrator and same-origin JSON", async () => {
  calls.length = 0;
  const body = { ...scope, action: "create" };
  expect((await POST(event({}, body))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, body))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, body))).status).toBe(403);
  expect((await POST(event(admin, body, "https://other.example"))).status).toBe(403);
  expect((await POST(event(admin, body, null))).status).toBe(403);
  expect((await POST(event(admin, body, "http://localhost", "text/plain"))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("fixture actions reject forged scope, extra authority, and invalid IDs before service calls", async () => {
  calls.length = 0;
  for (const body of [
    { ...scope, action: "create", qualification: { producer: "live-provider" } },
    { ...scope, action: "create", operationId: "../other" },
    { ...scope, action: "create", releaseId: "" },
    { ...scope, action: "qualify", operationId: "../other" },
    { ...scope, action: "qualify", qualification: { forged: true } },
    { ...scope, action: "status", projectId: "other-project" },
    { ...scope, action: "destroy", connectionId: undefined },
    { ...scope, action: "start" },
    { ...scope, action: "stop", powerOperationId: "../other" },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("qualify rejects incomplete host witness before store or provider activity", async () => {
  calls.length = 0;
  witnessReady = false;
  const response = await POST(event(admin, { ...scope, action: "qualify" }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "qualification_unavailable" });
  expect(calls).toEqual([]);
});

test("qualify fails closed when the operator root or exact ready fixture is absent", async () => {
  calls.length = 0;
  witnessReady = true;
  try {
    delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
    expect((await POST(event(admin, { ...scope, action: "qualify" }))).status).toBe(409);
    expect(calls).toEqual([]);
    process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
    fixtureReady = false;
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(calls).toEqual(["probe-fixture.construct:/private/operator", "probe-fixture.ready:connection:fixture-1"]);
  } finally { witnessReady = false; fixtureReady = true; }
});

test("qualify wires exact ready controls and the live witness into recordVerified", async () => {
  calls.length = 0;
  witnessReady = true;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  try {
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(calls).toEqual(["probe-fixture.construct:/private/operator", "probe-fixture.ready:connection:fixture-1",
      "control.construct:4", "witness.construct:true", "runner.construct:true:missing",
      "store.construct", "recordVerified:connection", "runner.execute"]);
  } finally { witnessReady = false; }
});

test("qualify returns only store-owned verification metadata", async () => {
  calls.length = 0;
  witnessReady = true;
  verifiedStoreResult = true;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  try {
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ qualification: { providerId: "incus", connectionId: "connection",
      presetId: "preset", releaseDigest: "a".repeat(64), verifiedAt: "2026-09-23T00:00:00Z",
      validUntil: "2026-09-24T00:00:00Z", cases: [{ caseId: "SP01", status: "passed" }] } });
    expect(calls).toEqual(["probe-fixture.construct:/private/operator", "probe-fixture.ready:connection:fixture-1",
      "control.construct:4", "witness.construct:true", "runner.construct:true:missing",
      "store.construct", "recordVerified:connection", "runner.execute"]);
  } finally { witnessReady = false; verifiedStoreResult = false; }
});

test("malformed JSON is rejected before fixture or provider activity", async () => {
  calls.length = 0;
  const base = event(admin, null);
  const invalid = { ...base, request: new Request(base.request.url, { method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" }) };
  expect((await POST(invalid)).status).toBe(400);
  expect(calls).toEqual([]);
});

test("operator actions pass the exact scope and return only safe durable state", async () => {
  calls.length = 0;
  const created = await POST(event(admin, { ...scope, action: "create" }));
  expect(created.status).toBe(202);
  const createdBody = await created.json();
  expect(createdBody).toMatchObject({ operation: { id: "controller-operation", kind: "CREATE" } });
  expect(JSON.stringify(createdBody)).not.toContain("privateKeyPem");
  const status = await POST(event(admin, { ...scope, action: "status" }));
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ fixture: { operationId: "fixture-1" }, binding: { observedState: "STOPPED" } });
  const destroyed = await POST(event(admin, { ...scope, action: "destroy" }));
  expect(destroyed.status).toBe(202);
  expect(await destroyed.json()).toMatchObject({ operation: { kind: "DESTROY" } });
  const started = await POST(event(admin, { ...scope, action: "start", powerOperationId: "power-1" }));
  expect(await started.json()).toMatchObject({ operation: { kind: "START" } });
  const stopped = await POST(event(admin, { ...scope, action: "stop", powerOperationId: "power-2" }));
  expect(await stopped.json()).toMatchObject({ operation: { kind: "STOP" } });
  expect(calls).toEqual(["create:connection:fixture-1", "status:connection:fixture-1", "destroy:connection:fixture-1",
    "power:connection:fixture-1:running:power-1", "power:connection:fixture-1:stopped:power-2"]);
});

test("fixture failures do not return provider or credential errors", async () => {
  calls.length = 0;
  fail = true;
  try {
    const response = await POST(event(admin, { ...scope, action: "create" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  } finally { fail = false; }
});
