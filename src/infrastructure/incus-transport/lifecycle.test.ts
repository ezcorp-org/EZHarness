import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import type { IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { incusManifest } from "../../../extensions/incus-sandbox/manifest";
import { up as addSandboxController } from "../../db/migrations/add-sandbox-controller";
import * as schema from "../../db/schema";
import type { ActiveExtensionRelease } from "../../extensions/release-process";
import { SandboxController } from "../../sandboxes/controller";
import { IncusSandboxProviderDispatcher } from "../../sandboxes/incus-dispatcher";
import { ProviderRpcBroker, type ProviderConnectionResolver } from "../provider-rpc-broker";
import { HostIncusLifecycleTransport } from "./lifecycle";
import { makeTestCertificates } from "./test-certificates";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const read = certificates.read;
const serverCertificatePem = read("server-cert.pem");
const serverKey = read("server-key.pem");
const clientCa = read("client-ca-cert.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(serverCertificatePem).raw).digest("hex");
const scope = { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1,
  approvedPreset: { profile: "linux-exec.v1", incusProfile: "ezharness", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "c".repeat(64),
    limits: { memoryBytes: 4_294_967_296, cpuMillis: 2_000, pids: 1_024, diskBytes: 21_474_836_480 } } };
const sandboxId = "sandbox-a";
const sandboxName = `ezh-${createHash("sha256").update("connection-a").update("\0").update(sandboxId).digest("hex").slice(0, 32)}`;
const command: IncusTransportRequest = { action: "instance.create", connectionId: "connection-a", deadlineMs: Date.now() + 30_000,
  pins: { connectionId: "connection-a", serverCertificateSha256: fingerprint, project: "sandbox", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
  tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection-a", sandboxId }, sandboxName,
  idempotency: { requestId: "request-a", key: "key-a" },
  payload: { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), desiredState: "running" } };
const connection = { endpoint: "https://127.0.0.1:8443", serverCertificatePem, project: "sandbox", clientCertificatePem: read("client-cert.pem"), privateKeyPem: read("client-key.pem") };
const reply = (metadata: unknown, status = 200) => Response.json({ type: status === 202 ? "async" : "sync", status_code: status, metadata }, { status });

test("wrong project, stale scope, and missing approved policy deny before HTTP", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return reply({}); };
  for (const [hostScope, resolved, expected] of [
    [scope, { ...connection, project: "other" }, "permission"],
    [{ ...scope, revision: 0 }, connection, "permission"],
    [{ ...scope, approvedPreset: undefined }, connection, "permission"],
  ] as const) {
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => resolved }, hostScope, fetcher as never);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: expected, effect: "none" });
  }
  expect(calls).toBe(0);
});

test("create takes image, profile and limits only from the host-approved policy", async () => {
  const routes: string[] = [];
  let created: Record<string, unknown> | undefined;
  const fetcher = async (url: string, init: RequestInit) => {
    routes.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`);
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply({ name: "ezharness", devices: { root: { type: "disk", path: "/", pool: "ezharness" } } }) : reply({}, 404);
    created = JSON.parse(String(init.body)) as Record<string, unknown>;
    return reply({ id: "operation-a" }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const result = await transport.request({ ...command, payload: { ...command.payload as object, image: "evil", profiles: ["default"], limits: { memoryBytes: 1 } } }) as Record<string, unknown>;
  expect(result.ok).toBe(true);
  expect(routes).toEqual([`GET /1.0/instances/${sandboxName}?project=sandbox`, "GET /1.0/profiles/ezharness?project=sandbox", "POST /1.0/instances?project=sandbox"]);
  expect(created?.source).toEqual({ type: "image", fingerprint: "c".repeat(64) });
  expect(created?.profiles).toEqual(["ezharness"]);
  expect((created!.config as Record<string, unknown>)["limits.memory"]).toBe("4294967296");
  expect(created!.devices).toEqual({ root: { type: "disk", path: "/", pool: "ezharness", size: "21474836480" } });
});

test("lost mutation response stays unknown with a stable operation identity", async () => {
  let writes = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply({ name: "ezharness", devices: { root: { type: "disk", path: "/", pool: "ezharness" } } }) : reply({}, 404);
    writes++;
    throw new Error("response lost");
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const failure = await transport.request(command).catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "unavailable", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-create-/);
  expect(writes).toBe(1);
});

test("readback settles a matching create and rejects another sandbox operation", async () => {
  let created: Record<string, unknown> | undefined;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply({ name: "ezharness", devices: { root: { type: "disk", path: "/", pool: "ezharness" } } })
      : created ? reply({ ...created, status: "Running" }) : reply({}, 404);
    created = JSON.parse(String(init.body)) as Record<string, unknown>;
    throw new Error("lost create response");
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const failure = await transport.request(command).catch((error: unknown) => error) as { operationId: string };
  const inspected = await transport.request({ ...command, action: "operation.inspect", idempotency: undefined, payload: { operationId: failure.operationId } }) as Record<string, unknown>;
  expect((inspected.operation as Record<string, unknown>).state).toBe("succeeded");
  await expect(transport.request({ ...command, action: "operation.inspect", idempotency: undefined, payload: { operationId: `ezh-create-${"0".repeat(64)}` } })).rejects.toMatchObject({ kind: "permission" });
});

test("completed Incus operations settle only after owned instance state or absence readback", async () => {
  const op = "11111111-1111-1111-1111-111111111111";
  const instance = { name: sandboxName, profiles: ["ezharness"], status: "Stopped",
    config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
      "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": "linux-exec.v1",
      "user.ezharness.preset_id": "incus-linux-exec-v1", "user.ezharness.create_key": "key-a",
      "user.ezharness.desired_state": "stopped", "user.ezharness.generation": "1" } };
  let present = true;
  const fetcher = async (url: string) => {
    const route = new URL(url).pathname;
    if (route.includes("/operations/")) return reply({ id: op, status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    return present ? reply(instance) : reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const inspect = async (kind: string) => transport.request({ ...command, action: "operation.inspect", idempotency: undefined,
    payload: { operationId: `incus-${kind}-${op}` } }) as Promise<{ operation: { state: string; observedState: string | null } }>;
  expect((await inspect("create")).operation).toMatchObject({ state: "succeeded", observedState: "stopped" });
  const dispatcher = new IncusSandboxProviderDispatcher({ call: async (_scope, _method, input) =>
    transport.request({ ...command, action: "operation.inspect", idempotency: undefined,
      payload: { operationId: input.operationId as string } }) });
  const request = (kind: "CREATE" | "DESTROY") => ({ kind, operationId: "journal-a", generation: 1,
    providerOperationId: `incus-${kind === "CREATE" ? "create" : "destroy"}-${op}`,
    payload: kind === "CREATE" ? { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) } : { expectedGeneration: 1 },
    idempotency: { scope: "feature", key: "key-a", payloadHash: "a".repeat(64) },
    binding: { id: sandboxId, projectId: "project", providerInstallationId: "installation-a", providerReleaseId: "release-a",
      connectionId: "connection-a", connectionRevision: 1, resourceKey: sandboxId, profile: "linux-exec.v1",
      presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) } });
  expect(await dispatcher.inspectOperation(request("CREATE") as never)).toMatchObject({ outcome: "SUCCEEDED", observedState: "STOPPED" });
  expect((await inspect("destroy")).operation).toMatchObject({ state: "outcome_unknown", observedState: "unknown" });
  present = false;
  expect((await inspect("destroy")).operation).toMatchObject({ state: "succeeded", observedState: "absent" });
  expect(await dispatcher.inspectOperation(request("DESTROY") as never)).toMatchObject({ outcome: "SUCCEEDED", observedState: "ABSENT" });
  expect((await inspect("create")).operation).toMatchObject({ state: "outcome_unknown", observedState: "unknown" });
});

test("absence alone cannot prove a synthetic destroy completed", async () => {
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope,
    (async () => reply({}, 404)) as never);
  const accepted = await transport.request({ ...command, action: "instance.destroy", payload: { expectedGeneration: 1 } }) as { receipt: { operationId: string } };
  const inspected = await transport.request({ ...command, action: "operation.inspect", idempotency: undefined,
    payload: { operationId: accepted.receipt.operationId } }) as { operation: { state: string } };
  expect(inspected.operation.state).toBe("outcome_unknown");
});

test("real preset and broker scope use the backend Incus profile for transport", async () => {
  const database = new PGlite();
  try {
    await database.waitReady;
    await database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const db = drizzle(database, { schema });
    await addSandboxController(db);
    await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/project" });
    const manifest = structuredClone(incusManifest);
    const preset = manifest.sandboxProviders![0]!.presets[0]!;
    preset.imageDigest = "c".repeat(64); // The published image pin fixture.
    const presetDigest = await sandboxPresetDigest(preset);
    const controller = new SandboxController(db, { dispatch: async () => { throw new Error("unused"); }, inspectOperation: async () => { throw new Error("unused"); } });
    await controller.createBinding({ id: sandboxId, projectId: "project", providerInstallationId: "installation-a", providerReleaseId: "release-a",
      connectionId: "connection-a", connectionRevision: 1, resourceKey: sandboxId, profile: preset.profile, presetId: preset.id,
      presetDigest, effectiveSettingsDigest: "b".repeat(64), observedState: "STOPPED" });
    const configured = { ...connection, id: "connection-a", revision: 1, providerInstallationId: "installation-a",
      providerReleaseId: "release-a", revokedAt: null, configuration: { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" } };
    const connections = { getMetadata: async () => configured, resolveForHost: async () => configured } as ProviderConnectionResolver;
    const broker = new ProviderRpcBroker(connections, undefined, db);
    const snapshot = { installation: { id: "installation-a", generation: 1 }, release: { id: "release-a", releaseDigest: "d".repeat(64), manifest } } as ActiveExtensionRelease;
    const input = { providerId: "incus", connectionId: "connection-a", sandboxId,
      rpcDeadlineMs: Date.now() + 30_000 };
    const action = await broker.prepareAction(snapshot, sandboxId, "lifecycle.inspect", input);
    expect(action.approvedPreset).toMatchObject({ profile: "linux-exec.v1", incusProfile: "ezharness" });
    const transport = new HostIncusLifecycleTransport(connections, {
      providerInstallationId: action.installationId, providerReleaseId: action.releaseId, revision: action.revision,
      approvedPreset: action.approvedPreset,
    }, (async () => reply({ name: action.expectedCommand.sandboxName, status: "Stopped", config: {
      "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
      "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": preset.profile,
      "user.ezharness.preset_id": preset.id, "user.ezharness.generation": "1",
    } })) as never);
    expect(await transport.request(action.expectedCommand)).toMatchObject({ ok: true, sandbox: { profile: preset.profile } });
  } finally { await database.close(); }
});

test("power intent advances generation with ETag before state change", async () => {
  const calls: string[] = [];
  const config = { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a", "user.ezharness.sandbox_id": sandboxId,
    "user.ezharness.profile": "ezharness", "user.ezharness.preset_id": "incus-linux-exec-v1", "user.ezharness.generation": "1" };
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (init.method === "GET") return Response.json({ type: "sync", status_code: 200, metadata: { name: sandboxName, status: "Stopped", config } }, { headers: { etag: '"revision-a"' } });
    if (init.method === "PATCH") {
      expect(new Headers(init.headers).get("if-match")).toBe('"revision-a"');
      expect((JSON.parse(String(init.body)) as { config: Record<string, string> }).config["user.ezharness.generation"]).toBe("2");
      return reply({});
    }
    return reply({ id: "11111111-1111-1111-1111-111111111111" }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const result = await transport.request({ ...command, action: "instance.setPower", payload: { desiredState: "running", expectedGeneration: 1 } }) as { receipt: { operationId: string } };
  expect(result.receipt.operationId).toBe("incus-setPower-11111111-1111-1111-1111-111111111111");
  expect(calls).toEqual([`GET /1.0/instances/${sandboxName}`, `PATCH /1.0/instances/${sandboxName}`, `PUT /1.0/instances/${sandboxName}/state`]);
});

test("mutation timeout reports unknown with the same readback identity", async () => {
  let posts = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply({ name: "ezharness", devices: { root: { type: "disk", path: "/", pool: "ezharness" } } }) : reply({}, 404);
    posts++;
    return new Promise<Response>(() => undefined);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const failure = await transport.request({ ...command, deadlineMs: Date.now() + 50 }).catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "deadline", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-create-/);
  expect(posts).toBe(1);
}, 2_000);

test("real TLS socket writes a create only after peer and client authentication", async () => {
  const requests: string[] = [];
  const server: Server = createServer({ cert: serverCertificatePem, key: serverKey, ca: clientCa, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.includes("/profiles/")) {
      response.end(JSON.stringify({ type: "sync", status_code: 200, metadata: { name: "ezharness", devices: { root: { type: "disk", path: "/", pool: "ezharness" } } } }));
    } else if (request.method === "GET") {
      response.statusCode = 404;
      response.end(JSON.stringify({ type: "error", status_code: 404, metadata: {} }));
    } else {
      response.statusCode = 202;
      response.end(JSON.stringify({ type: "async", status_code: 100, metadata: { id: "operation-a" } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => ({ ...connection, endpoint }) }, scope);
    await expect(transport.request(command)).resolves.toMatchObject({ ok: true });
    expect(requests).toEqual([`GET /1.0/instances/${sandboxName}?project=sandbox`, "GET /1.0/profiles/ezharness?project=sandbox", "POST /1.0/instances?project=sandbox"]);
    requests.length = 0;
    const wrong = new HostIncusLifecycleTransport({ resolveForHost: async () => ({ ...connection, endpoint, clientCertificatePem: "", privateKeyPem: "" }) }, scope);
    await expect(wrong.request(command)).rejects.toMatchObject({ kind: "unavailable" });
    expect(requests).toHaveLength(0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15_000);
