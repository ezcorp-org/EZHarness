import { expect, mock, test } from "bun:test";
import { projects, sandboxBindings, sandboxOperations } from "../../../../../../../src/db/schema";

const calls: string[] = [];
const project = { id: "project-a", purpose: "user" as "user" | "incus-qualification" };
const binding = { id: "binding-a", projectId: "project-a", connectionId: "connection-a", desiredState: "RUNNING", observedState: "UNKNOWN" };
const operation = { id: "operation-a", bindingId: "binding-a", kind: "CREATE", state: "DISPATCHING", generation: 1,
  providerOperationId: null, errorCode: null, createdAt: new Date("2026-09-22T12:00:00Z"), updatedAt: new Date("2026-09-22T12:00:00Z") };
const database = {
  select() {
    let source: unknown;
    const query = {
      from(table: unknown) { source = table; return query; },
      where() { return query; },
      orderBy() { return query; },
      limit: async () => source === projects ? [project]
        : source === sandboxBindings ? [binding]
        : source === sandboxOperations ? [operation] : [],
    };
    return query;
  },
};

mock.module("$server/db/connection", () => ({ getDb: () => database }));
mock.module("$server/infrastructure/incus-qualification", () => ({ IncusQualificationStore: class { async load() { calls.push("qualification.load"); return null; } } }));
mock.module("$server/infrastructure/incus-feature-service", () => ({
validIncusProjectName: (value: unknown) => typeof value === "string" && value.trim().length > 0
  && value.trim() === value && value.length <= 128 && !Array.from(value).some(c => c.charCodeAt(0) < 32),
IncusFeatureService: class {
  constructor(private readonly deps: { loadQualification: (scope: unknown) => Promise<unknown> }) {}
  async prepare(input: Record<string, unknown>) { calls.push(`prepare:${input.projectId}`); if (!await this.deps.loadQualification({})) throw new Error("Live Incus preset qualification is unavailable"); return binding; }
  async prepareProject(input: Record<string, unknown>) { calls.push(`prepareProject:${input.ownerUserId}:${input.idempotencyKey}`); return { project: { id: "guest-project", name: input.name }, binding }; }
  async create(input: Record<string, unknown>) { calls.push(`create:${input.bindingId}`); return input.idempotencyKey === "denied" ? { state: "REJECTED", reason: "capacity", operation: null } : { state: "DISPATCHED", operation }; }
  async start(input: Record<string, unknown>) { calls.push(`start:${input.bindingId}`); return { state: "QUEUED", reason: "capacity", operation: null }; }
  async stop(input: Record<string, unknown>) { calls.push(`stop:${input.bindingId}`); return operation; }
  async destroy(input: Record<string, unknown>) { calls.push(`destroy:${input.bindingId}`); return operation; }
  async destroyRetired(input: Record<string, unknown>) { calls.push(`destroyRetired:${input.bindingId}:${input.idempotencyScope}:${input.idempotencyKey}`); return operation; }
  async reconcile(limit?: number) { calls.push(`reconcile:${limit}`); return { processed: 0 }; }
} }));

const { POST } = await import("./+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
function event(locals: Record<string, unknown>, body: unknown, origin: string | null = "http://localhost", contentType = "application/json"): Parameters<typeof POST>[0] {
  return { locals, request: new Request("http://localhost/api/infrastructure/incus/features", {
    method: "POST", headers: { "content-type": contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }) } as unknown as Parameters<typeof POST>[0];
}

test("feature route denies anonymous, API key, and non-admin access", async () => {
  calls.length = 0;
  expect((await POST(event({}, { action: "reconcile" }))).status).toBe(401);
  expect((await POST(event({ ...admin, authMethod: "api-key" }, { action: "reconcile" }))).status).toBe(403);
  expect((await POST(event({ user: { id: "member", role: "member" }, authMethod: "session" }, { action: "reconcile" }))).status).toBe(403);
  expect(calls).toEqual([]);
});

test("feature route requires a same-origin JSON admin POST", async () => {
  calls.length = 0;
  expect((await POST(event(admin, { action: "reconcile" }, "https://other.example"))).status).toBe(403);
  expect((await POST(event(admin, { action: "reconcile" }, null))).status).toBe(403);
  expect((await POST(event(admin, { action: "reconcile" }, "http://localhost", "text/plain"))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("feature route rejects extra authority, missing idempotency, and malformed limits", async () => {
  calls.length = 0;
  for (const body of [
    { action: "prepare", projectId: "project-a", installationId: "install-a", connectionId: "connection-a", presetId: "preset-a", qualification: { forged: true } },
    { action: "create", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a" },
    { action: "start", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a", idempotencyKey: "", imageFingerprint: "a".repeat(64) },
    { action: "destroyRetired", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a" },
    { action: "destroyRetired", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a", idempotencyKey: "key-a", operation: "create" },
    { action: "reconcile", limit: 1000 },
  ]) expect((await POST(event(admin, body))).status).toBe(400);
  expect(calls).toEqual([]);
});

test("prepare refuses provisioning when host qualification is absent", async () => {
  calls.length = 0;
  const response = await POST(event(admin, { action: "prepare", projectId: "project-a", installationId: "install-a", connectionId: "connection-a", presetId: "preset-a" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "feature_unavailable" });
  expect(calls).toEqual(["prepare:project-a", "qualification.load"]);
});

test("prepareProject uses the session owner and rejects caller supplied project authority", async () => {
  calls.length = 0;
  const input = { action: "prepareProject", name: "Guest project", installationId: "install-a",
    connectionId: "connection-a", presetId: "preset-a", idempotencyKey: "new-project" };
  expect((await POST(event(admin, { ...input, projectId: "project-a" }))).status).toBe(400);
  expect((await POST(event(admin, { ...input, name: " Guest project" }))).status).toBe(400);
  const response = await POST(event(admin, input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ project: { id: "guest-project", name: "Guest project" },
    binding: { id: "binding-a" } });
  expect(calls).toEqual(["prepareProject:admin:new-project"]);
});

test("binding actions require matching project and preserve idempotency", async () => {
  calls.length = 0;
  const input = { action: "create", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a", idempotencyKey: "key-a" };
  const created = await POST(event(admin, input));
  expect(created.status).toBe(202);
  expect(await created.json()).toMatchObject({ state: "DISPATCHED" });
  const forged = await POST(event(admin, { ...input, projectId: "project-b" }));
  expect(forged.status).toBe(404);
  expect(calls).toEqual(["create:binding-a"]);
});

test("capacity rejection is reported as conflict", async () => {
  calls.length = 0;
  const response = await POST(event(admin, { action: "create", projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a", idempotencyKey: "denied" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ state: "REJECTED", reason: "capacity" });
});

test("retired destroy is a separate admin action with exact project and idempotency scope", async () => {
  calls.length = 0;
  const input = { action: "destroyRetired", projectId: "project-a", bindingId: "binding-a",
    idempotencyScope: "retired", idempotencyKey: "cleanup" };
  expect((await POST(event({}, input))).status).toBe(401);
  expect((await POST(event(admin, { ...input, projectId: "other" }))).status).toBe(404);
  const response = await POST(event(admin, input));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ operation: { id: "operation-a" } });
  expect(calls).toEqual(["destroyRetired:binding-a:retired:cleanup"]);
  await POST(event(admin, { ...input, action: "destroy" }));
  expect(calls.at(-1)).toBe("destroy:binding-a");
});

test("status and reconciliation expose only operator state", async () => {
  calls.length = 0;
  const status = await POST(event(admin, { action: "status", projectId: "project-a", bindingId: "binding-a" }));
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ binding: { id: "binding-a" }, operation: { id: "operation-a" } });
  const reconciled = await POST(event(admin, { action: "reconcile", limit: 5 }));
  expect(reconciled.status).toBe(200);
  expect(calls).toEqual(["reconcile:5"]);
});

test("feature status does not expose a qualification fixture as a user project", async () => {
  calls.length = 0;
  project.purpose = "incus-qualification";
  try {
    const response = await POST(event(admin, { action: "status", projectId: "project-a", bindingId: "binding-a" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(calls).toEqual([]);
  } finally {
    project.purpose = "user";
  }
});
