import { expect, test } from "bun:test";
import { createCapacityHandlers, createService, GET, POST } from "./+server";

const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
const url = "http://localhost/api/infrastructure/incus/capacity";

function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost",
  contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request(url, { method: "POST", headers: { "content-type": contentType,
    ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }) } as unknown as Parameters<typeof POST>[0];
}

test("capacity Plan and Apply require a same-origin admin session", async () => {
  const body = { action: "plan", setupId: "setup" };
  expect((await POST(event({}, body))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, body))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, body))).status).toBe(403);
  expect((await POST(event(admin, body, "https://other.example"))).status).toBe(403);
  expect((await POST(event(admin, body, null))).status).toBe(403);
  expect((await POST(event(admin, body, "http://localhost", "text/plain"))).status).toBe(400);
  expect((await GET({ locals: {}, url: new URL(`${url}?setupId=setup`) } as Parameters<typeof GET>[0])).status).toBe(401);
});

test("capacity route rejects extra authority, invalid plans, and oversized JSON before service access", async () => {
  for (const body of [
    { action: "plan", setupId: "setup", host: "other" },
    { action: "plan", setupId: "../setup" },
    { action: "apply", plan: {}, planDigest: "bad" },
    { action: "apply", plan: "bad", planDigest: "a".repeat(64) },
    { action: "other", setupId: "setup" },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  const oversized = { action: "plan", setupId: "setup", padding: "x".repeat(20_000) };
  expect((await POST(event(admin, oversized))).status).toBe(400);
  expect((await GET({ locals: admin, url: new URL(`${url}?setupId=../bad`) } as Parameters<typeof GET>[0])).status).toBe(400);
});

test("capacity service uses the configured bootstrap, database, and active release", async () => {
  const calls: string[] = [];
  const database = { marker: "database" };
  const bootstrap = { ssh: { marker: "ssh" } };
  let options: Record<string, unknown> | undefined;
  const dependencies = {
    bootstrapFromEnvironment: () => bootstrap,
    getExtensionLifecycle: async () => { calls.push("lifecycle"); },
    getDb: () => database,
    ProviderConnectionStore: class { constructor(db: unknown) { expect(db).toBe(database); } },
    IncusCapacityService: class { constructor(value: Record<string, unknown>) { options = value; } },
    resolveActiveRelease: async (id: string, runtime: unknown) => ({ id, runtime }),
    getReleaseRuntime: () => "runtime",
  } as unknown as Parameters<typeof createService>[0];
  expect(await createService({ ...dependencies, bootstrapFromEnvironment: () => null })).toBeNull();
  expect(calls).toEqual([]);
  expect(await createService(dependencies)).toBeTruthy();
  expect(calls).toEqual(["lifecycle"]);
  expect(options?.database).toBe(database);
  expect(options?.bootstrap).toBe(bootstrap.ssh);
  expect(options?.connections).toBeTruthy();
  const activeRelease = options?.activeRelease as (id: string) => Promise<unknown>;
  expect(await activeRelease("installation")).toEqual({ id: "installation", runtime: "runtime" });
});

test("capacity handlers return the reviewed plan, apply receipt, and saved receipt", async () => {
  const calls: unknown[][] = [];
  const plan = { reviewed: "plan" };
  const receipt = { applied: true };
  const capacity = {
    plan: async (setupId: string) => { calls.push(["plan", setupId]); return plan; },
    apply: async (value: unknown, digest: string, principal: string) => {
      calls.push(["apply", value, digest, principal]); return receipt;
    },
    status: async (setupId: string) => { calls.push(["status", setupId]); return receipt; },
  } as unknown as NonNullable<Awaited<ReturnType<Parameters<typeof createCapacityHandlers>[0]>>>;
  const handlers = createCapacityHandlers(async () => capacity);
  const digest = "a".repeat(64);
  const planned = await handlers.POST(event(admin, { action: "plan", setupId: "setup:1" }));
  expect(planned.status).toBe(200);
  expect(await planned.json()).toEqual({ plan });
  const applied = await handlers.POST(event(admin, { action: "apply", plan, planDigest: digest }));
  expect(applied.status).toBe(200);
  expect(await applied.json()).toEqual({ receipt });
  const saved = await handlers.GET({ locals: admin, url: new URL(`${url}?setupId=setup:1`) } as Parameters<typeof GET>[0]);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ receipt });
  expect(calls).toEqual([["plan", "setup:1"], ["apply", plan, digest, "admin"], ["status", "setup:1"]]);
});

test("capacity handlers report missing bootstrap and service failures", async () => {
  const missing = createCapacityHandlers(async () => null);
  const failing = createCapacityHandlers(async () => { throw new Error("service failed"); });
  for (const handlers of [missing, failing]) {
    const expected = handlers === missing ? { status: 503, code: "bootstrap_not_configured" }
      : { status: 409, code: "capacity_unavailable" };
    for (const response of [
      await handlers.GET({ locals: admin, url: new URL(`${url}?setupId=setup`) } as Parameters<typeof GET>[0]),
      await handlers.POST(event(admin, { action: "plan", setupId: "setup" })),
    ]) {
      expect(response.status).toBe(expected.status);
      expect((await response.json()).code).toBe(expected.code);
    }
  }
  const operationFails = createCapacityHandlers(async () => ({
    status: async () => { throw new Error("status failed"); },
    plan: async () => { throw new Error("plan failed"); },
    apply: async () => { throw new Error("apply failed"); },
  }) as unknown as NonNullable<Awaited<ReturnType<Parameters<typeof createCapacityHandlers>[0]>>>);
  const digest = "a".repeat(64);
  expect((await operationFails.GET({ locals: admin, url: new URL(`${url}?setupId=setup`) } as Parameters<typeof GET>[0])).status).toBe(409);
  expect((await operationFails.POST(event(admin, { action: "plan", setupId: "setup" }))).status).toBe(409);
  expect((await operationFails.POST(event(admin, { action: "apply", plan: {}, planDigest: digest }))).status).toBe(409);
});

test("capacity handlers reject malformed or missing JSON before service access", async () => {
  let serviceCalls = 0;
  const handlers = createCapacityHandlers(async () => { serviceCalls++; return null; });
  for (const body of ["{broken", "[]", "null", "42"]) {
    const request = new Request(url, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body });
    expect((await handlers.POST({ locals: admin, request } as Parameters<typeof POST>[0])).status).toBe(400);
  }
  const request = new Request(url, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" } });
  expect((await handlers.POST({ locals: admin, request } as Parameters<typeof POST>[0])).status).toBe(400);
  expect((await handlers.GET({ locals: admin, url: new URL(url) } as Parameters<typeof GET>[0])).status).toBe(400);
  expect(serviceCalls).toBe(0);
});

test("default capacity route reports missing host bootstrap", async () => {
  const response = await GET({ locals: admin, url: new URL(`${url}?setupId=setup`) } as Parameters<typeof GET>[0]);
  expect([503, 409]).toContain(response.status);
});

test("oversized request stays invalid when stream cancellation fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20_000)); },
    cancel() { throw new Error("cancel failed"); },
  });
  const request = new Request(url, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
    body, duplex: "half" } as RequestInit);
  expect((await POST({ locals: admin, request } as Parameters<typeof POST>[0])).status).toBe(400);
});
