import { afterEach, expect, mock, test } from "bun:test";

const { IncusQualificationPreparationError, INCUS_PREPARATION_CAUSE_CODES } = await import("$server/infrastructure/incus-live-cases");
let preparationError: InstanceType<typeof IncusQualificationPreparationError> | null = null;
const calls: string[] = [];
let fail = false;
const { IncusQualificationOperationUnsettledError } = await import("$server/infrastructure/incus-qualification");
function preservedError(operationId: string, state: unknown, reason: unknown = "outcome_unsettled") {
  const error = new IncusQualificationOperationUnsettledError(operationId, "JOURNALED", new Error("privateKeyPem secret provider payload"));
  return Object.assign(error, { state, reason });
}
let unsettledError: InstanceType<typeof IncusQualificationOperationUnsettledError> | null = null;
const warnings: Array<{ message: string; fields: unknown }> = [];
mock.module("$server/logger", () => ({ logger: { child: () => ({ warn: (message: string, fields: unknown) => warnings.push({ message, fields }) }) } }));
let witnessReady = false;
let selectedPinsReady = true;
let beginResult = false;
let fixtureReady = true;
const originalRoot = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
afterEach(() => {
  if (originalRoot === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = originalRoot;
});
mock.module("$server/infrastructure/incus-host-live-witness", () => ({
  incusHostLiveWitnessReady: async () => witnessReady,
}));
mock.module("$server/infrastructure/incus-startup", () => ({
  createIncusQualificationWitness: async (input: { connectionId: string }, operationId: string,
    _db: unknown, deps: { qualificationOwnerId: string }) => {
    expect(deps.qualificationOwnerId).toBe("admin");
    calls.push(`witness.create:${input.connectionId}:${operationId}`);
    if (!selectedPinsReady) throw new Error("Incus selected operator pins are unavailable");
    if (unsettledError) throw unsettledError;
    if (!process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT || !fixtureReady) throw new Error("control unavailable");
    return { name: "operator-witness" };
  },
}));
mock.module("$server/infrastructure/incus-live-cases", () => ({
  IncusQualificationPreparationError, INCUS_PREPARATION_CAUSE_CODES,
  beginDurableIncusLiveCases: async (options: { witness: unknown; composeFixtureImageRef?: string },
    _scope: unknown, _preset: unknown, run: { runId: string; nonce: string; deadlineMs: number }) => {
    calls.push(`runner.begin:${Boolean(options.witness)}:${options.composeFixtureImageRef ?? "missing"}:${run.runId}`);
    expect(run.nonce).toMatch(/^[a-f0-9-]{36}$/);
    expect(run.deadlineMs).toBeGreaterThan(Date.now());
    if (preparationError) throw preparationError;
    if (beginResult) return { runId: run.runId, state: "AWAITING_RESTART" };
    throw new Error("mock restart unavailable");
  },
}));
const operation = { id: "controller-operation", kind: "CREATE", state: "SUCCEEDED", generation: 1,
  providerOperationId: "provider-operation", errorCode: null, requestPayload: { privateKeyPem: "secret" } };
mock.module("$server/infrastructure/incus-qualification", () => ({
  IncusQualificationOperationUnsettledError,
  IncusQualificationStore: class {
    async authorizeFixture(scope: { connectionId: string }) {
      calls.push(`authorize:${scope.connectionId}`);
      return { preset: { id: "preset" } };
    }
  },
  IncusQualificationFixtureService: class {
  constructor(deps: { qualificationOwnerId: string }) {
    expect(deps.qualificationOwnerId).toBe("admin");
  }
  async create(scope: { connectionId: string }, id: string) {
    calls.push(`create:${scope.connectionId}:${id}`);
    if (unsettledError) throw unsettledError;
    if (fail) throw new Error("connection credentials secret");
    return operation;
  }
  async status(scope: { connectionId: string }, id: string) {
    calls.push(`status:${scope.connectionId}:${id}`);
    if (fail) throw new Error("connection credentials secret");
    return { fixture: { operationId: id, connectionId: scope.connectionId },
      binding: { id: "fixture-binding", observedState: "STOPPED" }, operation: { id: operation.id } };
  }
  async recoverCleanup(scope: { connectionId: string }, id: string, failedId: string) {
    calls.push(`recoverCleanup:${scope.connectionId}:${id}:${failedId}`);
    return { recovery: { id: "recovery", state: "STOP_REQUIRED", failedDestroyOperationId: failedId,
      stopOperationId: "saved-stop", destroyOperationId: "saved-destroy", privateKeyPem: "SECRET" }, operation };
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
    expect(calls).toEqual(["authorize:connection", "witness.create:connection:fixture-1"]);
    process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
    fixtureReady = false;
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(calls).toEqual(["authorize:connection", "witness.create:connection:fixture-1",
      "authorize:connection", "witness.create:connection:fixture-1"]);
  } finally { witnessReady = false; fixtureReady = true; }
});

test("qualify starts a durable run and does not publish a pass from this process", async () => {
  calls.length = 0;
  witnessReady = true;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  try {
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(calls).toEqual(["authorize:connection", "witness.create:connection:fixture-1",
      "runner.begin:true:missing:fixture-1"]);
  } finally { witnessReady = false; }
});

test("qualify returns only the durable run identity and pending state", async () => {
  calls.length = 0;
  witnessReady = true;
  beginResult = true;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  try {
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ run: { runId: "fixture-1", state: "AWAITING_RESTART" } });
    expect(calls).toEqual(["authorize:connection", "witness.create:connection:fixture-1",
      "runner.begin:true:missing:fixture-1"]);
  } finally { witnessReady = false; beginResult = false; }
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
  warnings.length = 0;
  try {
    const response = await POST(event(admin, { ...scope, action: "create" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(warnings).toEqual([]);
  } finally { fail = false; }
});


test("unsettled qualification returns its saved operation and forbids an unsafe retry", async () => {
  warnings.length = 0;
  witnessReady = true;
  try {
    for (const state of ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"]) {
      unsettledError = preservedError("saved-controller-operation", state);
      const response = await POST(event(admin, { ...scope, action: "qualify" }));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "qualification_operation_preserved", operation: { id: "saved-controller-operation", state } });
      expect(body.message).toContain("Do not retry qualification");
      expect(body.message).toContain("saved-controller-operation");
      expect(JSON.stringify(body)).not.toMatch(/privateKeyPem|secret|provider payload/);
    }
    expect(warnings).toHaveLength(4);
    expect(warnings[3]).toEqual({ message: "Saved Incus qualification operation requires review", fields: {
      action: "qualify", installationId: "installation", connectionId: "connection", operationId: "saved-controller-operation", state: "OUTCOME_UNKNOWN", reason: "outcome_unsettled" } });
    expect(JSON.stringify(warnings)).not.toMatch(/privateKeyPem|secret|provider payload/);
  } finally { unsettledError = null; witnessReady = false; }
});

test("invalid or terminal typed diagnostics remain redacted", async () => {
  warnings.length = 0;
  try {
    for (const [id, state] of [["../privateKeyPem-secret", "OUTCOME_UNKNOWN"], ["saved-operation", "SUCCEEDED"], ["saved-operation", "privateKeyPem-secret"]]) {
      unsettledError = preservedError(id, state);
      const response = await POST(event(admin, { ...scope, action: "create" }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "qualification_unavailable",
        message: "The Incus qualification fixture is unavailable for this scope. Check host logs and its saved status." });
    }
    expect(warnings).toEqual([]);
  } finally { unsettledError = null; }
});


test("saved successful operations remain reviewable only for an explicit intent or authority change", async () => {
  warnings.length = 0;
  try {
    for (const reason of ["newer_intent", "authority_changed"]) {
      unsettledError = preservedError("saved-successful-operation", "SUCCEEDED", reason);
      const response = await POST(event(admin, { ...scope, action: "create" }));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "qualification_operation_preserved", operation: { id: "saved-successful-operation", state: "SUCCEEDED" }, reason });
      expect(body.message).toContain("Do not retry qualification or repeat the mutation");
      expect(JSON.stringify(body)).not.toContain("secret");
    }
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain("secret");
    unsettledError = preservedError("saved-operation", "SUCCEEDED", "secret reason");
    const invalid = await POST(event(admin, { ...scope, action: "create" }));
    expect(invalid.status).toBe(409);
    expect((await invalid.json()).code).toBe("qualification_unavailable");
    expect(warnings).toHaveLength(2);
  } finally { unsettledError = null; }
});

test("qualification recovery uses exact fixture scope and saved failed ID with safe receipts", async () => {
  calls.length = 0;
  const response = await POST(event(admin, { ...scope, action: "recoverCleanup", failedDestroyOperationId: "failed-destroy" }));
  expect(response.status).toBe(202);
  const result = await response.json();
  expect(result.recovery).toEqual({ id: "recovery", state: "STOP_REQUIRED", failedDestroyOperationId: "failed-destroy", stopOperationId: "saved-stop", destroyOperationId: "saved-destroy" });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(calls).toEqual([`recoverCleanup:${scope.connectionId}:${scope.operationId}:failed-destroy`]);
});


test("qualification preparation failure exposes only a safe stage and cleanup result", async () => {
  witnessReady = true;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/probe";
  warnings.length = 0;
  try {
    preparationError = new IncusQualificationPreparationError("enforcement", "confirmed", "guest_reached_a_forbidden_network_target");
    Object.assign(preparationError, { message: "privateKeyPem secret", cause: new Error("provider secret") });
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "qualification_preparation_failed", stage: "enforcement", cleanup: "confirmed", causeCode: "guest_reached_a_forbidden_network_target",
      message: "Qualification failed during enforcement (guest_reached_a_forbidden_network_target); cleanup confirmed. Inspect the saved fixtures before starting another run." });
    expect(JSON.stringify(warnings)).not.toContain("secret");
    expect(warnings).toHaveLength(1);
    Object.assign(preparationError, { stage: "secret-stage" });
    const invalid = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(await invalid.json()).toMatchObject({ code: "qualification_unavailable" });
    expect(warnings).toHaveLength(1);
  } finally { preparationError = null; witnessReady = false; }
});

test("CPU failure response and logger expose only bounded numeric measurement fields", async () => {
  const cpuLoad = { throttledDelta: 0, elapsedMs: 4000, quotaMicros: 200000, periodMicros: 100000,
    cpusetCount: 32, affinityCount: 32, outsideCpuCount: 0, workerCount: 3, workerFailures: 0, workerCpuUsec: 7_000_000,
    usageDeltaUsec: 7_100_000, controlsUnchanged: true, affinityConfined: true };
  try {
    witnessReady = true; process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/approved-controls";
    preparationError = new IncusQualificationPreparationError("limit_loads", "confirmed", "cpu_load_did_not_prove_containment", cpuLoad);
    Object.assign(cpuLoad, { token: "private-secret", stderr: "private-error" });
    const response = await POST(event(admin, { action: "qualify", installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset", operationId: "cpu-run" }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.cpuLoad.workerCount).toBe(3); expect(body.cpuLoad.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(warnings.at(-1))).not.toContain("private");
    Object.assign(cpuLoad, { usageDeltaUsec: Infinity });
    const malformed = await POST(event(admin, { action: "qualify", installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset", operationId: "cpu-run" }));
    expect((await malformed.json()).cpuLoad).toBeUndefined();
  } finally { preparationError = null; witnessReady = false; }
});

test("load diagnostic projects each finite resource and excludes arbitrary causes from reply and logs", async () => {
  witnessReady = true; process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/approved-controls";
  try {
    for (const resource of ["memory", "cpu", "pids", "disk", "secret-canary"] as const) {
      preparationError = new IncusQualificationPreparationError("limit_loads", "unverified", "guest_processes_readOutput_deadline_exceeded", null, resource as "memory");
      Object.assign(preparationError, { message: "secret-canary stderr", cause: new Error("secret-canary credentials"), detail: "secret-canary output" });
      const response = await POST(event(admin, { action: "qualify", ...scope, operationId: "load-diagnostic" }));
      const body = await response.json();
      expect(response.status).toBe(409);
      expect(body.causeCode).toBe("guest_processes_readOutput_deadline_exceeded");
      expect(body.limitResource).toBe(resource === "secret-canary" ? undefined : resource);
      expect(JSON.stringify(body)).not.toContain("secret-canary");
      expect(JSON.stringify(warnings.at(-1))).not.toContain("secret-canary");
    }
  } finally { preparationError = null; witnessReady = false; }
});


test("qualify refuses stale selected operator pins before durable preparation or allocation", async () => {
  calls.length = 0; witnessReady = true; selectedPinsReady = false;
  try {
    const response = await POST(event(admin, { ...scope, action: "qualify" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "qualification_unavailable",
      message: "The Incus qualification fixture is unavailable for this scope. Check host logs and its saved status." });
    expect(calls).toEqual(["authorize:connection", "witness.create:connection:fixture-1"]);
  } finally { selectedPinsReady = true; witnessReady = false; }
});
