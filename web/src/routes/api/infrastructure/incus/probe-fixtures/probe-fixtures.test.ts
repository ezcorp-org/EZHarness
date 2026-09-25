import { afterAll, expect, mock, test } from "bun:test";

const originalRoot = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
afterAll(() => {
  if (originalRoot === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = originalRoot;
});

const calls: string[] = [];
let fail = false;
mock.module("$server/infrastructure/incus-live-probe-fixtures", () => ({
  IncusLiveProbeFixtureService: class {
    constructor(input: { rootDirectory: string }) { calls.push(`root:${input.rootDirectory}`); }
    async plan(scope: { connectionId: string }, operationId: string) {
      calls.push(`plan:${scope.connectionId}:${operationId}`);
      if (fail) throw new Error("private server path /secret");
      return { digest: "a".repeat(64), operationId, scope,
        config: { cases: { unsupported: { canaryPath: "/private/canary" } } } };
    }
    async status(scope: { connectionId: string }, operationId: string) {
      calls.push(`status:${scope.connectionId}:${operationId}`);
      if (fail) throw new Error("private server path /secret");
      return { state: "ready", receipt: { planDigest: "a".repeat(64) } };
    }
    async apply(scope: { connectionId: string }, operationId: string, digest: string) {
      calls.push(`apply:${scope.connectionId}:${operationId}:${digest}`);
      if (fail) throw new Error("private server path /secret");
      return { config: { cases: {} }, receipt: { state: "ready", planDigest: digest } };
    }
    async cleanup(scope: { connectionId: string }, operationId: string, digest: string) {
      calls.push(`cleanup:${scope.connectionId}:${operationId}:${digest}`);
      if (fail) throw new Error("private server path /secret");
      return { state: "cleaned", planDigest: digest };
    }
  },
}));

const { POST } = await import("./+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
  presetId: "preset", operationId: "run-one" };
const planDigest = "a".repeat(64);

function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost",
  contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request("http://localhost/api/infrastructure/incus/probe-fixtures", {
    method: "POST", headers: { "content-type": contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }) } as unknown as Parameters<typeof POST>[0];
}

test("probe fixture actions require a session administrator and same-origin JSON", async () => {
  calls.length = 0;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  const body = { ...scope, action: "plan" };
  expect((await POST(event({}, body))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, body))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, body))).status).toBe(403);
  expect((await POST(event(admin, body, "https://other.example"))).status).toBe(403);
  expect((await POST(event(admin, body, null))).status).toBe(403);
  expect((await POST(event(admin, body, "http://localhost", "text/plain"))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("strict action schema rejects forged scope, arbitrary paths, and invalid digests", async () => {
  calls.length = 0;
  for (const body of [
    { ...scope, action: "plan", canaryPath: "/tmp/attacker" },
    { ...scope, action: "plan", operationId: "../escape" },
    { ...scope, action: "status", projectId: "unrelated" },
    { ...scope, action: "apply" },
    { ...scope, action: "apply", planDigest: "A".repeat(64) },
    { ...scope, action: "cleanup", planDigest, rootDirectory: "/tmp/attacker" },
    { ...scope, action: "unknown" },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  const base = event(admin, null);
  const invalid = { ...base, request: new Request(base.request.url, { method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{" }) };
  expect((await POST(invalid)).status).toBe(400);
  expect(calls).toEqual([]);
});

test("missing host-owned root fails closed before service construction", async () => {
  calls.length = 0;
  const prior = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  try {
    const response = await POST(event(admin, { ...scope, action: "plan" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "probe_root_not_configured" });
    expect(calls).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
    else process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = prior;
  }
});

test("plan, status, apply, and cleanup dispatch exact scope and reviewed digest", async () => {
  calls.length = 0;
  process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT = "/private/operator";
  const plan = await POST(event(admin, { ...scope, action: "plan" }));
  expect(plan.status).toBe(200);
  expect(await plan.json()).toMatchObject({ plan: { digest: planDigest } });
  const status = await POST(event(admin, { ...scope, action: "status" }));
  expect(await status.json()).toMatchObject({ state: "ready" });
  const apply = await POST(event(admin, { ...scope, action: "apply", planDigest }));
  expect(await apply.json()).toMatchObject({ receipt: { state: "ready", planDigest } });
  const cleanup = await POST(event(admin, { ...scope, action: "cleanup", planDigest }));
  expect(await cleanup.json()).toMatchObject({ receipt: { state: "cleaned", planDigest } });
  expect(calls).toEqual(["root:/private/operator", "plan:connection:run-one",
    "root:/private/operator", "status:connection:run-one",
    "root:/private/operator", `apply:connection:run-one:${planDigest}`,
    "root:/private/operator", `cleanup:connection:run-one:${planDigest}`]);
});

test("service errors do not return private host paths", async () => {
  calls.length = 0;
  fail = true;
  try {
    const response = await POST(event(admin, { ...scope, action: "status" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("/secret");
  } finally { fail = false; }
});
