import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { IncusTransportError, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
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
const safeProfile = { name: "ezharness", devices: { eth0: { type: "nic", name: "eth0", network: "ezharness0", "security.port_isolation": "true" },
  root: { type: "disk", path: "/", pool: "ezharness" } } };

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
      ? reply(safeProfile) : reply({}, 404);
    created = JSON.parse(String(init.body)) as Record<string, unknown>;
    return reply({ id: "operation-a" }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const result = await transport.request({ ...command, payload: { ...command.payload as object, image: "evil", profiles: ["default"], limits: { memoryBytes: 1 } } }) as Record<string, unknown>;
  expect(result.ok).toBe(true);
  expect((result.receipt as { operationId: string }).operationId).toMatch(/^ezh-create-/);
  expect((result.receipt as { operationId: string }).operationId).toBe((created!.config as Record<string, string>)["user.ezharness.operation_id"]!);
  expect(routes).toEqual([`GET /1.0/instances/${sandboxName}?project=sandbox`, "GET /1.0/profiles/ezharness?project=sandbox", "POST /1.0/instances?project=sandbox"]);
  expect(created?.source).toEqual({ type: "image", fingerprint: "c".repeat(64) });
  expect(created?.profiles).toEqual(["ezharness"]);
  expect((created!.config as Record<string, unknown>)["limits.memory"]).toBe("4294967296");
  expect((created!.config as Record<string, unknown>)["limits.cpu"]).toBe("2");
  expect((created!.config as Record<string, unknown>)["limits.cpu.allowance"]).toBe("2000ms/1000ms");
  expect(created!.devices).toEqual({ root: { type: "disk", path: "/", pool: "ezharness", size: "21474836480" } });
});

test("a TLS failure on the first CREATE read leaves no provider effect", async () => {
  for (const failure of [new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
    new IncusTransportError("unavailable", "TLS failed")]) {
    const methods: string[] = [];
    const fetcher = async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      throw failure;
    };
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope,
      fetcher as never);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: "unavailable", effect: "none" });
    expect(methods).toEqual(["GET"]);
  }
});

test("create refuses a feature NIC without backend port isolation before allocation", async () => {
  let writes = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method !== "GET") { writes++; return reply({ id: "unexpected" }, 202); }
    if (new URL(url).pathname.includes("/profiles/")) return reply({ ...safeProfile,
      devices: { ...safeProfile.devices, eth0: { ...safeProfile.devices.eth0, "security.port_isolation": "false" } } });
    return reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "permission", effect: "none" });
  expect(writes).toBe(0);
});

test("create refuses an extra profile device before allocation", async () => {
  let writes = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method !== "GET") { writes++; return reply({ id: "unexpected" }, 202); }
    if (new URL(url).pathname.includes("/profiles/")) return reply({ ...safeProfile,
      devices: { ...safeProfile.devices, eth1: { type: "nic", name: "eth1", network: "unsafe" } } });
    return reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "permission", effect: "none" });
  expect(writes).toBe(0);
});

test("lost mutation response stays unknown with a stable operation identity", async () => {
  let writes = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply(safeProfile) : reply({}, 404);
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
      ? reply(safeProfile)
      : created ? reply({ ...created, status: "Running", config: { ...created.config as object, "volatile.base_image": "c".repeat(64) } }) : reply({}, 404);
    created = JSON.parse(String(init.body)) as Record<string, unknown>;
    throw new Error("lost create response");
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const failure = await transport.request(command).catch((error: unknown) => error) as { operationId: string };
  const inspected = await transport.request({ ...command, action: "operation.inspect", payload: { operationId: failure.operationId } }) as Record<string, unknown>;
  expect((inspected.operation as Record<string, unknown>).state).toBe("succeeded");
  await expect(transport.request({ ...command, action: "operation.inspect", payload: { operationId: `ezh-create-${"0".repeat(64)}` } })).rejects.toMatchObject({ kind: "permission" });
});

test("expired native CREATE settles only from its exact stopped journal-tagged instance", async () => {
  const nativeId = "11111111-1111-1111-1111-111111111111";
  const create = { ...command, payload: { ...command.payload as object, desiredState: "stopped" } };
  let instance: Record<string, unknown> | null = null;
  let posts = 0;
  const routes: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname;
    routes.push(`${init.method} ${route}`);
    if (route.includes("/operations/")) return reply({}, 404);
    if (route.includes("/profiles/")) return reply(safeProfile);
    if (init.method === "POST") {
      posts++;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      instance = { ...body, status: "Stopped", config: { ...body.config as object, "volatile.base_image": "c".repeat(64) } };
      return reply({ id: nativeId }, 202);
    }
    return instance ? reply(instance) : reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const accepted = await transport.request(create) as { receipt: { operationId: string } };
  expect(accepted.receipt.operationId).toMatch(/^ezh-create-/);
  const inspect = async (idempotency = create.idempotency) => transport.request({ ...create, action: "operation.inspect", idempotency,
    payload: { operationId: `incus-create-${nativeId}` } }) as Promise<{ operation: { state: string; observedState: string } }>;
  expect((await inspect()).operation).toMatchObject({ state: "succeeded", observedState: "stopped" });
  expect(posts).toBe(1);
  expect(routes.slice(-2)).toEqual([`GET /1.0/operations/${nativeId}`, `GET /1.0/instances/${sandboxName}`]);

  const exact = structuredClone(instance) as unknown as Record<string, unknown>;
  const config = exact.config as Record<string, unknown>;
  const wrong = [
    null,
    { ...exact, status: "Running" },
    { ...exact, config: { ...config, "user.ezharness.desired_state": "running" } },
    { ...exact, config: { ...config, "user.ezharness.operation_id": "ezh-create-wrong" } },
    { ...exact, config: { ...config, "user.ezharness.create_key": "other-journal" } },
    { ...exact, config: { ...config, "user.ezharness.sandbox_id": "other-sandbox" } },
    { ...exact, config: { ...config, "user.ezharness.connection_id": "other-connection" } },
    { ...exact, config: { ...config, "user.ezharness.profile": "other-profile" } },
    { ...exact, config: { ...config, "user.ezharness.preset_id": "other-preset" } },
    { ...exact, config: { ...config, "volatile.base_image": "d".repeat(64) } },
    { ...exact, config: { ...config, "user.ezharness.generation": "2" } },
    { ...exact, profiles: ["other-profile"] },
  ];
  for (const candidate of wrong) {
    instance = candidate;
    expect((await inspect()).operation.state).toBe("outcome_unknown");
  }
  instance = exact;
  const noJournal = await transport.request({ ...create, action: "operation.inspect", idempotency: undefined,
    payload: { operationId: `incus-create-${nativeId}` } }) as { operation: { state: string } };
  expect(noJournal.operation.state).toBe("outcome_unknown");
  expect((await inspect({ requestId: "another-journal", key: "another-journal" })).operation.state).toBe("outcome_unknown");
  expect(posts).toBe(1);
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

test("a scoped lost destroy reply follows the real DELETE, successful provider operation, and pinned absence", async () => {
  const op = "11111111-1111-1111-1111-111111111111";
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": "linux-exec.v1",
    "user.ezharness.preset_id": "incus-linux-exec-v1", "user.ezharness.generation": "1" } };
  const calls: string[] = [];
  let deleted = false;
  let consumed = 0;
  const fault = { matches: (request: IncusTransportRequest) => request.action === "instance.destroy"
    && request.idempotency?.requestId === "destroy-journal-a",
    consume: () => { consumed++; return true; } };
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.includes("/operations/")) return reply({ status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    if (init.method === "GET") return deleted ? reply({}, 404)
      : Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"generation-1"' } });
    if (init.method === "DELETE") { deleted = true; return reply({ id: op }, 202); }
    return reply({});
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never, fault);
  const destroy = { ...command, action: "instance.destroy" as const,
    idempotency: { requestId: "destroy-journal-a", key: "destroy-journal-a" },
    payload: { expectedGeneration: 1 } };
  await expect(transport.request(destroy)).rejects.toMatchObject({ kind: "unavailable", effect: "unknown",
    operationId: `incus-destroy-${op}` });
  expect(consumed).toBe(1);
  expect(calls).toEqual([`GET /1.0/instances/${sandboxName}`, `PATCH /1.0/instances/${sandboxName}`,
    `DELETE /1.0/instances/${sandboxName}`, `GET /1.0/operations/${op}`, `GET /1.0/instances/${sandboxName}`]);
});

test("a destroy reply is not suppressed when provider inspection cannot prove the effect", async () => {
  const op = "11111111-1111-1111-1111-111111111111";
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": "linux-exec.v1",
    "user.ezharness.preset_id": "incus-linux-exec-v1", "user.ezharness.generation": "1" } };
  for (const providerStatus of ["Running", "Success", "missing-operation"] as const) {
    let consumed = 0;
    let deleted = false;
    const fetcher = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes("/operations/")) return providerStatus === "missing-operation"
        ? reply({}, 404)
        : reply({ status: providerStatus, resources: { instances: [`/1.0/instances/${sandboxName}`] } });
      if (init.method === "GET") return deleted && providerStatus !== "Success" ? reply({}, 404)
        : Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"generation-1"' } });
      if (init.method === "DELETE") { deleted = true; return reply({ id: op }, 202); }
      return reply({});
    };
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never,
      { matches: () => true, consume: () => { consumed++; return true; } });
    const result = await transport.request({ ...command, action: "instance.destroy", deadlineMs: Date.now() + 250,
      payload: { expectedGeneration: 1 } }) as { receipt: { operationId: string } };
    expect(result.receipt.operationId).toBe(`incus-destroy-${op}`);
    expect(consumed).toBe(0);
  }
});

test("real preset and broker scope use the backend Incus profile for transport", async () => {
  const database = new PGlite();
  try {
    await database.waitReady;
    await database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
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

test("expired native power receipt settles only the exact host-journaled instance intent", async () => {
  const nativeId = "incus-setPower-11111111-1111-1111-1111-111111111111";
  const inspect = { ...command, action: "operation.inspect" as const,
    idempotency: { requestId: "journal-start", key: "journal-start" },
    payload: { operationId: nativeId, readback: { expectedGeneration: 1, desiredState: "running" } } };
  const stableId = `ezh-setPower-${sandboxName.slice(4)}-${createHash("sha256")
    .update("connection-a\0sandbox-a\0journal-start\0journal-start\0setPower").digest("hex").slice(0, 32)}`;
  const config = { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": "linux-exec.v1",
    "user.ezharness.preset_id": "incus-linux-exec-v1", "volatile.base_image": "c".repeat(64),
    "user.ezharness.generation": "2", "user.ezharness.operation_id": stableId,
    "user.ezharness.desired_state": "running" };
  let instance = { name: sandboxName, status: "Running", type: "container", profiles: ["ezharness"], config };
  const fetcher = async (url: string) => new URL(url).pathname.startsWith("/1.0/operations/")
    ? reply({}, 404) : reply(instance);
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  expect(await transport.request(inspect)).toMatchObject({ operation: { state: "succeeded", kind: "setPower", observedState: "running" } });
  for (const changed of [
    { config: { ...config, "user.ezharness.operation_id": "another-intent" } },
    { config: { ...config, "user.ezharness.generation": "3" } },
    { status: "Stopped" },
    { config: { ...config, "user.ezharness.desired_state": "stopped" } },
    { config: { ...config, "user.ezharness.sandbox_id": "other-sandbox" } },
    { config: { ...config, "volatile.base_image": "d".repeat(64) } },
    { profiles: ["other-profile"] },
  ]) {
    instance = { ...instance, ...changed };
    expect(await transport.request(inspect)).toMatchObject({ operation: { state: "outcome_unknown" } });
    instance = { name: sandboxName, status: "Running", type: "container", profiles: ["ezharness"], config };
  }
  expect(await transport.request({ ...inspect, idempotency: undefined })).toMatchObject({ operation: { state: "outcome_unknown" } });
  const stopInspect = { ...inspect, idempotency: { requestId: "journal-stop", key: "journal-stop" },
    payload: { operationId: "incus-setPower-22222222-2222-2222-2222-222222222222",
      readback: { expectedGeneration: 2, desiredState: "stopped" } } };
  const stopMarker = `ezh-setPower-${sandboxName.slice(4)}-${createHash("sha256")
    .update("connection-a\0sandbox-a\0journal-stop\0journal-stop\0setPower").digest("hex").slice(0, 32)}`;
  instance = { ...instance, status: "Stopped", config: { ...config,
    "user.ezharness.generation": "3", "user.ezharness.operation_id": stopMarker,
    "user.ezharness.desired_state": "stopped" } };
  expect(await transport.request(stopInspect)).toMatchObject({ operation: { state: "succeeded", observedState: "stopped" } });
});

test("expired native destroy receipt confirms only scoped absence, never an unreachable or present guest", async () => {
  const inspect = { ...command, action: "operation.inspect" as const,
    idempotency: { requestId: "journal-destroy", key: "journal-destroy" },
    payload: { operationId: "incus-destroy-11111111-1111-1111-1111-111111111111",
      readback: { expectedGeneration: 2, desiredState: "absent" } } };
  let instanceStatus = 404;
  const fetcher = async (url: string) => new URL(url).pathname.startsWith("/1.0/operations/")
    ? reply({}, 404) : instanceStatus === 404 ? reply({}, 404)
      : instanceStatus === 200 ? reply({ name: sandboxName, status: "Stopped", config: {
        "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
        "user.ezharness.sandbox_id": sandboxId } }) : new Response("", { status: instanceStatus });
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  expect(await transport.request(inspect)).toMatchObject({ operation: { kind: "destroy", state: "succeeded", observedState: "absent" } });
  instanceStatus = 200;
  expect(await transport.request(inspect)).toMatchObject({ operation: { state: "outcome_unknown" } });
  instanceStatus = 503;
  await expect(transport.request(inspect)).rejects.toMatchObject({ kind: "unavailable" });
  instanceStatus = 404;
  expect(await transport.request({ ...inspect, idempotency: undefined })).toMatchObject({ operation: { state: "outcome_unknown" } });
});

test("mutation timeout reports unknown with the same readback identity", async () => {
  let posts = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    if (init.method === "GET") return new URL(url).pathname.includes("/profiles/")
      ? reply(safeProfile) : reply({}, 404);
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
      response.end(JSON.stringify({ type: "sync", status_code: 200, metadata: safeProfile }));
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


test("instance list returns only owned, valid sandboxes in stable pages", async () => {
  const owned = (id: string) => ({ name: `ezh-${createHash("sha256").update("connection-a").update("\0").update(id).digest("hex").slice(0, 32)}`,
    status: "Running", config: { "user.ezharness.managed_by": "ezharness-incus-sandbox",
      "user.ezharness.connection_id": "connection-a", "user.ezharness.sandbox_id": id,
      "user.ezharness.profile": "linux-exec.v1", "user.ezharness.preset_id": "incus-linux-exec-v1",
      "user.ezharness.generation": "1" } });
  const entries = [owned("b"), { ...owned("a"), config: { ...owned("a").config, "user.ezharness.connection_id": "other" } },
    owned("c"), { ...owned("invalid"), name: "ezh-forged" }, owned("a"),
    { ...owned("wrong"), config: { ...owned("wrong").config, "user.ezharness.generation": "zero" } }];
  let calls = 0;
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope,
    (async () => { calls++; return reply(entries); }) as never);
  const list = (payload: Record<string, unknown>) => transport.request({ ...command, action: "instance.list",
    sandboxName: undefined, tags: { ...command.tags, sandboxId: undefined }, idempotency: undefined, payload: payload as IncusTransportRequest["payload"] });
  const first = await list({ limit: 1 }) as { sandboxes: Array<{ sandboxId: string }>; nextCursor: object };
  expect(first.sandboxes.map(item => item.sandboxId)).toEqual(["a"]);
  expect(first.nextCursor).toEqual({ connectionId: "connection-a", afterSandboxId: "a" });
  const second = await list({ limit: 2, cursor: first.nextCursor }) as { sandboxes: Array<{ sandboxId: string }> };
  expect(second.sandboxes.map(item => item.sandboxId)).toEqual(["b", "c"]);
  expect(calls).toBe(2);
});
