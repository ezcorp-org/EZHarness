import { afterAll, expect, mock, test } from "bun:test";

const calls: string[] = [];
const files = new Map<string, Uint8Array>();
const operation = { id: "controller-op", bindingId: "fixture-binding", kind: "CREATE", state: "SUCCEEDED",
  generation: 1, providerOperationId: "provider-op", errorCode: null,
  requestPayload: { privateKeyPem: "secret" } };
let observedState = "RUNNING";
let fail = false;
let composeOutput = "ezh-compose-ok";
let latestOperation = operation;
let powerSequence = 0;
let nextPowerState: "SUCCEEDED" | "OUTCOME_UNKNOWN" = "SUCCEEDED";
const originalImage = process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF;
afterAll(() => {
  if (originalImage === undefined) delete process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF;
  else process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF = originalImage;
});

mock.module("$server/infrastructure/incus-qualification", () => ({
  IncusQualificationFixtureService: class {
    async create(scope: { connectionId: string }, id: string) {
      calls.push(`create:${scope.connectionId}:${id}`);
      if (fail) throw new Error("private certificate secret");
      observedState = "STOPPED";
      latestOperation = operation;
      return operation;
    }
    async status(scope: { connectionId: string }, id: string) {
      calls.push(`status:${scope.connectionId}:${id}`);
      if (fail) throw new Error("private certificate secret");
      return { fixture: { operationId: id, connectionId: scope.connectionId,
        bindingId: "fixture-binding" }, binding: { id: "fixture-binding",
        generation: 1, desiredState: observedState, observedState }, operation: latestOperation };
    }
    async setPower(scope: { connectionId: string }, id: string, state: string, key: string) {
      calls.push(`power:${scope.connectionId}:${id}:${state}:${key}`);
      if (fail) throw new Error("private certificate secret");
      latestOperation = { ...operation, id: `power-${++powerSequence}`,
        kind: state === "running" ? "START" : "STOP", state: nextPowerState };
      observedState = nextPowerState === "SUCCEEDED" ? state === "running" ? "RUNNING" : "STOPPED" : "UNKNOWN";
      nextPowerState = "SUCCEEDED";
      return latestOperation;
    }
    async destroy(scope: { connectionId: string }, id: string) {
      calls.push(`destroy:${scope.connectionId}:${id}`);
      if (fail) throw new Error("private certificate secret");
      latestOperation = { ...operation, id: "destroy-op", kind: "DESTROY" };
      observedState = "ABSENT";
      return latestOperation;
    }
  },
}));
mock.module("$server/infrastructure/incus-host-live-witness", () => ({
  IncusHostLiveWitness: class {
    async inspectFixture(handle: { sandboxId: string; operationId: string }) {
      calls.push(`inspect:${handle.sandboxId}:${handle.operationId}`);
      return { sandboxId: handle.sandboxId, state: "running", bootId: "boot" };
    }
    async run(handle: { sandboxId: string }, argv: string[], timeoutMs: number) {
      calls.push(`run:${handle.sandboxId}:${JSON.stringify(argv)}:${timeoutMs}`);
      if (fail) throw new Error("private certificate secret");
      if (argv[0] === "test") return { exitCode: files.has(argv[2]!) ? 0 : 1, stdout: "", stderr: "" };
      if (argv[0] === "docker") return { exitCode: 0, stdout: composeOutput, stderr: "" };
      throw new Error("unexpected guest command");
    }
    async writeFile(handle: { sandboxId: string }, path: string, bytes: Uint8Array) {
      calls.push(`write:${handle.sandboxId}:${path}`);
      files.set(path, bytes);
    }
    async readFile(handle: { sandboxId: string }, path: string) {
      calls.push(`read:${handle.sandboxId}:${path}`);
      return files.get(path)!;
    }
  },
}));

const { POST } = await import("./+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
  presetId: "preset", operationId: "incus-smoke-one" };
const image = `docker.io/library/busybox@sha256:${"a".repeat(64)}`;

function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost",
  contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request("http://localhost/api/infrastructure/incus/smoke", {
    method: "POST", headers: { "content-type": contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }) } as unknown as Parameters<typeof POST>[0];
}

test("smoke actions require an admin session and same-origin JSON", async () => {
  calls.length = 0;
  const body = { ...scope, action: "create" };
  expect((await POST(event({}, body))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, body))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, body))).status).toBe(403);
  expect((await POST(event(admin, body, "https://elsewhere.example"))).status).toBe(403);
  expect((await POST(event(admin, body, null))).status).toBe(403);
  expect((await POST(event(admin, body, "http://localhost", "text/plain"))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("smoke input cannot choose guest commands, paths, images, or provider authority", async () => {
  calls.length = 0;
  for (const body of [
    { ...scope, action: "create", argv: ["sh"] },
    { ...scope, action: "marker", path: "../../host" },
    { ...scope, action: "compose", imageRef: image },
    { ...scope, action: "start", generation: 99 },
    { ...scope, action: "destroy", operationId: "other" },
    { ...scope, action: "status", connectionId: "" },
    { ...scope, action: "unknown" },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  const base = event(admin, null);
  expect((await POST({ ...base, request: new Request(base.request.url, { method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" }) })).status).toBe(400);
  expect(calls).toEqual([]);
});

test("create, power, durable status, inspect, and destroy use one exact fixture identity", async () => {
  calls.length = 0;
  powerSequence = 0;
  expect((await POST(event(admin, { ...scope, action: "create" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "create" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "start" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "start" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "stop" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "stop" }))).status).toBe(202);
  expect((await POST(event(admin, { ...scope, action: "start" }))).status).toBe(202);
  const status = await POST(event(admin, { ...scope, action: "status" }));
  expect(await status.json()).toMatchObject({ fixture: { bindingId: "fixture-binding" } });
  const inspection = await POST(event(admin, { ...scope, action: "inspect" }));
  expect(await inspection.json()).toMatchObject({ inspection: { sandboxId: "fixture-binding" } });
  const destroyed = await POST(event(admin, { ...scope, action: "destroy" }));
  expect(await destroyed.json()).toMatchObject({ operation: { kind: "DESTROY" } });
  expect(calls).toEqual(["create:connection:incus-smoke-one", "create:connection:incus-smoke-one",
    "status:connection:incus-smoke-one",
    "power:connection:incus-smoke-one:running:smoke-start-g1-after-controller-op",
    "status:connection:incus-smoke-one", "status:connection:incus-smoke-one",
    "power:connection:incus-smoke-one:stopped:smoke-stop-g1-after-power-1",
    "status:connection:incus-smoke-one", "status:connection:incus-smoke-one",
    "power:connection:incus-smoke-one:running:smoke-start-g1-after-power-2",
    "status:connection:incus-smoke-one", "status:connection:incus-smoke-one",
    "inspect:fixture-binding:incus-smoke-one", "destroy:connection:incus-smoke-one"]);
});

test("an unknown power result replays its saved receipt and blocks the opposite transition", async () => {
  calls.length = 0;
  latestOperation = operation;
  observedState = "STOPPED";
  nextPowerState = "OUTCOME_UNKNOWN";
  const first = await POST(event(admin, { ...scope, action: "start" }));
  expect((await first.json()).operation).toMatchObject({ state: "OUTCOME_UNKNOWN" });
  const replay = await POST(event(admin, { ...scope, action: "start" }));
  expect((await replay.json()).operation).toMatchObject({ id: latestOperation.id, state: "OUTCOME_UNKNOWN" });
  expect((await POST(event(admin, { ...scope, action: "stop" }))).status).toBe(409);
  expect(calls.filter(call => call.startsWith("power:"))).toHaveLength(1);
});

test("power denies a predecessor from another binding generation", async () => {
  calls.length = 0;
  latestOperation = { ...operation, generation: 2 };
  observedState = "STOPPED";
  expect((await POST(event(admin, { ...scope, action: "start" }))).status).toBe(409);
  expect(calls).toEqual(["status:connection:incus-smoke-one"]);
});

test("fixed marker is read back and replay does not overwrite it", async () => {
  calls.length = 0;
  files.clear();
  observedState = "RUNNING";
  const first = await POST(event(admin, { ...scope, action: "marker" }));
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ marker: { path: "ezh-smoke-marker" } });
  const second = await POST(event(admin, { ...scope, action: "marker" }));
  expect(second.status).toBe(200);
  expect(calls.filter(call => call.startsWith("write:"))).toEqual(["write:fixture-binding:ezh-smoke-marker"]);
  expect(Buffer.from(files.get("ezh-smoke-marker")!).toString()).toContain("EZHarness Incus smoke");
});

test("Compose uses only a host-owned pinned image and the fixed one-shot recipe", async () => {
  calls.length = 0;
  files.clear();
  process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF = "docker.io/library/busybox:latest";
  expect((await POST(event(admin, { ...scope, action: "compose" }))).status).toBe(503);
  expect(calls).toEqual([]);
  process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF = image;
  const response = await POST(event(admin, { ...scope, action: "compose" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ compose: { imageRef: image, outputMarker: "ezh-compose-ok" } });
  expect(Buffer.from(files.get("ezh-smoke-compose.yaml")!).toString()).toContain(`image: ${image}`);
  expect(calls).toContain('run:fixture-binding:["docker","compose","-f","ezh-smoke-compose.yaml","run","--rm","proof"]:120000');
  composeOutput = "wrong";
  expect((await POST(event(admin, { ...scope, action: "compose" }))).status).toBe(409);
  composeOutput = "ezh-compose-ok";
});

test("stopped fixtures cannot run guest work and failures hide host secrets", async () => {
  calls.length = 0;
  observedState = "STOPPED";
  expect((await POST(event(admin, { ...scope, action: "marker" }))).status).toBe(409);
  expect(calls).toEqual(["status:connection:incus-smoke-one"]);
  observedState = "RUNNING";
  fail = true;
  try {
    const response = await POST(event(admin, { ...scope, action: "create" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  } finally { fail = false; }
});
