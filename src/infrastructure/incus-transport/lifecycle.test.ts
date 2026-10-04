import { RunnerError } from "@ezcorp/extension-runner";
import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type SandboxProtocolOperation, sandboxPresetDigest, sandboxProviderMethodSchemas, SANDBOX_PROVIDER_OPERATIONS, compileValueSchema } from "@ezcorp/extension-contract";
import { IncusTransportError, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { IncusSandboxAdapter } from "../../../extensions/incus-sandbox/adapter";
import { incusManifest } from "../../../extensions/incus-sandbox/manifest";
import { up as addQualificationFixtures } from "../../db/migrations/add-incus-qualification-fixtures";
import { HostIncusLostDestroyReplyFault } from "../incus-destroy-reply-fault";
import { up as addSandboxController } from "../../db/migrations/add-sandbox-controller";
import * as schema from "../../db/schema";
import type { ActiveExtensionRelease } from "../../extensions/release-process";
import { SandboxAdmissionStore } from "../../sandboxes/admission";
import { SandboxController } from "../../sandboxes/controller";
import { IncusSandboxProviderDispatcher } from "../../sandboxes/incus-dispatcher";
import { ProviderRpcBroker, type ProviderConnectionResolver } from "../provider-rpc-broker";
import { HostIncusLifecycleTransport, withSession } from "./lifecycle";
import { makeTestCertificates } from "./test-certificates";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const read = certificates.read;
const serverCertificatePem = read("server-cert.pem");
const serverKey = read("server-key.pem");
const clientCa = read("client-ca-cert.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(serverCertificatePem).raw).digest("hex");
const scope = { hostContractMinor: 1 as const, providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1,
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

test("session permits the canonical read-only API root without widening route authority", async () => {
  const requests: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`);
    return reply({ api_version: "1.0" });
  };
  await withSession({ resolveForHost: async () => connection }, scope, fetcher as never, command, async session => {
    expect((await session.request("GET", "/1.0?project=sandbox")).status).toBe(200);
    for (const path of ["/1.0-other", "/1.00", "/", "https://other.invalid/1.0"]) {
      await expect(session.request("GET", path)).rejects.toMatchObject({ kind: "permission", effect: "none" });
    }
    await expect(session.request("PUT", "/1.0")).rejects.toMatchObject({ kind: "permission", effect: "none" });
  });
  expect(requests).toEqual(["GET /1.0?project=sandbox"]);
});

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
    return reply({ id: "11111111-1111-4111-8111-111111111111" }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const result = await transport.request({ ...command, payload: { ...command.payload as object, image: "evil", profiles: ["default"], limits: { memoryBytes: 1 } } }) as Record<string, unknown>;
  expect(result.ok).toBe(true);
  expect((result.receipt as { operationId: string }).operationId).toBe("incus-create-11111111-1111-4111-8111-111111111111");
  expect((created!.config as Record<string, string>)["user.ezharness.operation_id"]).toMatch(/^ezh-create-/);
  expect(routes).toEqual([`GET /1.0/instances/${sandboxName}?project=sandbox`, "GET /1.0/profiles/ezharness?project=sandbox", "POST /1.0/instances?project=sandbox", expect.stringMatching(/^GET \/1\.0\/operations\/11111111-1111-4111-8111-111111111111\/wait\?timeout=\d+&project=sandbox$/)]);
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

test("lost CREATE reply remains unknown despite a visible matching instance and rejects foreign operation", async () => {
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
  expect((inspected.operation as Record<string, unknown>).state).toBe("outcome_unknown");
  await expect(transport.request({ ...command, action: "operation.inspect", payload: { operationId: `ezh-create-${"0".repeat(64)}` } })).rejects.toMatchObject({ kind: "permission" });
});

test("expired native CREATE preserves uncertainty even with an exact stopped journal-tagged instance", async () => {
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
  expect(accepted.receipt.operationId).toBe(`incus-create-${nativeId}`);
  const inspect = async (idempotency = create.idempotency) => transport.request({ ...create, action: "operation.inspect", idempotency,
    payload: { operationId: `incus-create-${nativeId}` } }) as Promise<{ operation: { state: string; observedState: string } }>;
  expect((await inspect()).operation).toMatchObject({ state: "outcome_unknown", observedState: "unknown" });
  expect(posts).toBe(1);
  expect(routes.at(-1)).toBe(`GET /1.0/operations/${nativeId}`);

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
      "user.ezharness.desired_state": "stopped", "user.ezharness.generation": "1",
      "volatile.base_image": "c".repeat(64), "user.ezharness.operation_id": `ezh-create-${sandboxName.slice(4)}-${createHash("sha256").update("connection-a\0sandbox-a\0request-a\0key-a\0create").digest("hex").slice(0, 32)}` } };
  let present = true;
  const fetcher = async (url: string) => {
    const route = new URL(url).pathname;
    if (route.includes("/operations/")) return reply({ id: op, status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    return present ? reply(instance) : reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const inspect = async (kind: string) => transport.request({ ...command, action: "operation.inspect", idempotency: command.idempotency,
    payload: { operationId: `incus-${kind}-${op}` } }) as Promise<{ operation: { state: string; observedState: string | null } }>;
  expect((await inspect("create")).operation).toMatchObject({ state: "succeeded", observedState: "stopped" });
  const dispatcher = new IncusSandboxProviderDispatcher({ call: async (_scope, _method, input) =>
    transport.request({ ...command, action: "operation.inspect", idempotency: command.idempotency,
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

    // CREATE and START advanced the guest to generation 2 while the durable
    // binding stayed at generation 1. A saved STOP must inspect generation 3.
    const stopJournalId = "journal-stop";
    const stopProviderId = "incus-setPower-22222222-2222-2222-2222-222222222222";
    await db.insert(schema.sandboxOperations).values({ id: stopJournalId, bindingId: sandboxId,
      kind: "STOP", generation: 1, idempotencyScope: "incus-qualification-power",
      idempotencyKey: "fixture:stop", payloadHash: "stop-hash", requestPayload: { expectedGeneration: 2 },
      state: "OUTCOME_UNKNOWN", providerOperationId: stopProviderId });
    await db.update(schema.sandboxBindings).set({ currentOperationId: stopJournalId,
      desiredState: "STOPPED", observedState: "RUNNING" });
    const stableId = `ezh-setPower-${sandboxName.slice(4)}-${createHash("sha256")
      .update(`connection-a\0${sandboxId}\0${stopJournalId}\0${stopJournalId}\0setPower`).digest("hex").slice(0, 32)}`;
    const stoppedInstance = { name: sandboxName, status: "Stopped", type: "container", profiles: ["ezharness"],
      config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
        "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": preset.profile,
        "user.ezharness.preset_id": preset.id, "volatile.base_image": preset.imageDigest,
        "user.ezharness.generation": "3", "user.ezharness.operation_id": stableId,
        "user.ezharness.desired_state": "stopped" } };
    const readbackTransport = new HostIncusLifecycleTransport(connections, {
      providerInstallationId: action.installationId, providerReleaseId: action.releaseId,
      revision: action.revision, approvedPreset: action.approvedPreset,
    }, (async (url: string) => new URL(url).pathname.includes("/operations/")
      ? reply({}, 404) : reply(stoppedInstance)) as never);
    const readbackBroker = new ProviderRpcBroker(connections, undefined, db, () => readbackTransport);
    const stopInput = { ...input, operationId: stopProviderId };
    const stopAction = await readbackBroker.prepareAction(snapshot, sandboxId, "lifecycle.inspectOperation", stopInput);
    const inspected = await readbackBroker.request(stopAction,
      { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs) as { ok: boolean;
        result?: { operation?: { state: string; observedState: string } } };
    expect(inspected).toMatchObject({ ok: true, result: { operation: {
      state: "succeeded", observedState: "stopped" } } });
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
  expect(calls).toEqual([`GET /1.0/instances/${sandboxName}`, `PATCH /1.0/instances/${sandboxName}`, `PUT /1.0/instances/${sandboxName}/state`, "GET /1.0/operations/11111111-1111-1111-1111-111111111111/wait"]);
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
      response.end(JSON.stringify({ type: "async", status_code: 100, metadata: { id: "11111111-1111-4111-8111-111111111111" } }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => ({ ...connection, endpoint }) }, scope);
    await expect(transport.request(command)).resolves.toMatchObject({ ok: true });
    expect(requests).toEqual([`GET /1.0/instances/${sandboxName}?project=sandbox`, "GET /1.0/profiles/ezharness?project=sandbox", "POST /1.0/instances?project=sandbox", expect.stringMatching(/^GET \/1\.0\/operations\/11111111-1111-4111-8111-111111111111\/wait\?timeout=\d+&project=sandbox$/)]);
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


async function invokeActualAdapterWorker(config: IncusTransportRequest["pins"], operation: SandboxProtocolOperation,
  input: Record<string, unknown>, request: (command: IncusTransportRequest) => Promise<unknown>,
  installLoss: (lose: () => void) => void) {
  const script = `import { createInterface } from "node:readline";
    import { IncusSandboxAdapter } from ${JSON.stringify(new URL("../../../extensions/incus-sandbox/adapter.ts", import.meta.url).href)};
    let resolve;
    const lines = createInterface({input:process.stdin});
    lines.on("line", async line => {
      const message = JSON.parse(line);
      if (message.type === "response") { resolve(message.result); return; }
      const adapter = new IncusSandboxAdapter(message.config, {request: command => new Promise(done => {
        resolve = done; console.log(JSON.stringify({type:"request",command}));
      })});
      try { console.log(JSON.stringify({type:"result",result:await adapter.invoke(message.operation,message.input)})); }
      catch(error) { console.log(JSON.stringify({type:"error",message:String(error)})); }
    });`;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let rejectResult!: (error: unknown) => void;
  let resolveResult!: (value: unknown) => void;
  const result = new Promise<unknown>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  installLoss(() => { child.kill(); rejectResult(new RunnerError("runner_unavailable", "Actual adapter worker terminated before its RPC reply")); });
  child.stdin.write(`${JSON.stringify({type:"invoke",config,operation,input})}\n`);
  const reader = (async () => {
    let buffered = "";
    const decoder = new TextDecoder();
    const outputReader = child.stdout.getReader();
    for (;;) {
      const { done, value: chunk } = await outputReader.read();
      if (done) break;
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (message.type === "request") {
          const response = await request(message.command);
          if (child.exitCode === null && child.signalCode === null) child.stdin.write(`${JSON.stringify({type:"response",result:response})}\n`);
        } else if (message.type === "result") resolveResult(message.result);
        else rejectResult(new Error(message.message));
      }
    }
  })().catch(rejectResult);
  try { return await result; }
  finally { child.kill(); await child.exited; await reader; }
}

async function exerciseAdapterLifecycle(faultMode?: "consume" | "expire", pendingCreate = false, failureKind?: "CREATE" | "START" | "PATCH" | "PATCH_SUCCESS", legacyProducer = false, lostReturnPhase?: "accepted" | "terminal", slowCreate = false, resumeCreate = false) {
  const database = new PGlite();
  let observationBroker: ProviderRpcBroker | undefined;
  try {
    await database.waitReady;
    await database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const db = drizzle(database, { schema });
    await addSandboxController(db);
    await database.exec("INSERT INTO projects (id,name,path) VALUES ('project', 'project', '/work/project')");
    const manifest = structuredClone(incusManifest);
    if (legacyProducer) {
      manifest.version = "0.1.3";
      manifest.sandboxProviders![0]!.minimumHostContract!.minor = 0;
      for (const operation of SANDBOX_PROVIDER_OPERATIONS) {
        const method = manifest.methods!.find(item => item.name === `incus/${operation.replace(".", "/")}`)!;
        Object.assign(method, sandboxProviderMethodSchemas(operation, 0));
      }
    }
    const preset = manifest.sandboxProviders![0]!.presets[0]!;
    preset.imageDigest = "c".repeat(64);
    const presetDigest = await sandboxPresetDigest(preset);
    const snapshot = { installation: { id: "installation-a", generation: 1 }, release: { id: "release-a", releaseDigest: "d".repeat(64), manifest } } as ActiveExtensionRelease;
    const configured = { ...connection, id: "connection-a", revision: 1, providerInstallationId: "installation-a", providerReleaseId: "release-a",
      revokedAt: null, configuration: { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" } };
    const connections = { getMetadata: async () => configured, resolveForHost: async () => configured } as ProviderConnectionResolver;
    let instance: { name: string; status: string; type: string; profiles: string[]; config: Record<string, string> } | undefined;
    let nativeSequence = 0;
    let faultNow = Date.now();
    let destroyInspections = 0;
    let armedDestroyId = "";
    const fault = faultMode ? new HostIncusLostDestroyReplyFault(db, {
      authenticateOperator: async () => {}, authorizeRun: async () => {}, authorizeReadback: async () => {},
    }, () => faultNow) : undefined;
    if (fault) {
      await database.exec("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, provider_installation_id TEXT NOT NULL, provider_release_id TEXT NOT NULL, endpoint TEXT NOT NULL, server_certificate_pem TEXT NOT NULL, project TEXT NOT NULL, configuration JSONB, client_certificate_pem TEXT NOT NULL, private_key_ciphertext TEXT NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
      await addQualificationFixtures(db);
      await db.update(schema.projects).set({ purpose: "incus-qualification" });
      await db.insert(schema.providerConnections).values({ id: "connection-a", revision: 1, providerInstallationId: "installation-a", providerReleaseId: "release-a", endpoint: connection.endpoint, serverCertificatePem, project: "sandbox", clientCertificatePem: connection.clientCertificatePem, privateKeyCiphertext: "test-not-a-secret" });
    }
    const writes: string[] = [];
    let createWaits = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (init.method === "GET") {
        if (path.includes("/profiles/")) return reply(safeProfile);
        if (path.includes("/operations/")) {
          if (slowCreate && nativeSequence === 1) {
            // The first bounded invocation returns while cloning remains pending.
            // A later normal tick sees an expired receipt; an already waiting
            // host observer alone can capture the terminal completion.
            if (!path.endsWith("/wait")) return reply({}, 404);
            createWaits++;
            return reply({ status: createWaits === 1 ? "Running" : "Success",
              resources: { instances: [`/1.0/instances/${sandboxName}`] } });
          }
          if (failureKind && failureKind !== "PATCH_SUCCESS" && nativeSequence === (failureKind === "CREATE" ? 1 : 2)) return reply({ status: "Failure", err: "private provider error bytes", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
          if (pendingCreate && nativeSequence === 1) return reply({ status: "Running", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
          if (!fault || nativeSequence !== 6) return reply({ status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
          destroyInspections++;
          if (destroyInspections === 1) {
            if (faultMode === "expire") faultNow += 25_001;
            return reply({ status: "Running", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
          }
          return reply({ status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
        }
        return instance ? Response.json({ type: "sync", status_code: 200, metadata: instance }, { headers: { etag: `"generation-${instance.config["user.ezharness.generation"]}"` } }) : reply({}, 404);
      }
      writes.push(`${init.method} ${path}`);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (init.method === "POST") {
        instance = { name: body.name, status: "Stopped", type: "container", profiles: body.profiles,
          config: { ...body.config, "volatile.base_image": preset.imageDigest } };
      } else if (init.method === "PATCH") {
        expect(new Headers(init.headers).get("if-match")).toBe(`"generation-${instance!.config["user.ezharness.generation"]}"`);
        Object.assign(instance!.config, body.config);
        if (failureKind === "PATCH" || failureKind === "PATCH_SUCCESS") { nativeSequence++; return reply({ id: `11111111-1111-1111-1111-${String(nativeSequence).padStart(12, "0")}` }, 202); }
        return reply({});
      } else if (init.method === "PUT") instance!.status = body.action === "start" ? "Running" : "Stopped";
      else if (init.method === "DELETE") {
        expect(instance!.status).toBe("Stopped");
        instance = undefined;
      }
      nativeSequence++;
      return reply({ id: `11111111-1111-1111-1111-${String(nativeSequence).padStart(12, "0")}` }, 202);
    };
    let loseWorkerReturn: () => void = () => { throw new Error("Worker loss barrier is not installed"); };
    const actionTransportFactory: ConstructorParameters<typeof ProviderRpcBroker>[3] = (prepared, _signal, recordAcceptedOperation, recordTerminalObservation, observeNativeWait) => new HostIncusLifecycleTransport(connections, {
      providerInstallationId: prepared.installationId, providerReleaseId: prepared.releaseId, revision: prepared.revision, approvedPreset: prepared.approvedPreset, hostContractMinor: prepared.hostContractMinor, observeNativeWait,
      recordAcceptedOperation: recordAcceptedOperation ? async id => { await recordAcceptedOperation(id); if (lostReturnPhase === "accepted") loseWorkerReturn(); } : undefined,
      recordTerminalObservation: recordTerminalObservation ? async observation => { await recordTerminalObservation(observation); if (lostReturnPhase === "terminal") loseWorkerReturn(); } : undefined,
    }, fetcher as never, fault);
    const broker = new ProviderRpcBroker(connections, undefined, db, actionTransportFactory, undefined,
      slowCreate ? { resolveActiveRelease: async () => { if (resumeCreate) throw new Error("Original engine observation is unavailable"); return snapshot; } } : undefined);
    observationBroker = broker;
    const controller = new SandboxController(db, new IncusSandboxProviderDispatcher({ call: async (_scope, method, input) => {
      const operation = (method.endsWith("inspectOperation") ? "lifecycle.inspectOperation" : method.endsWith("create") ? "lifecycle.create"
        : method.endsWith("destroy") ? "lifecycle.destroy" : "lifecycle.setPower") as SandboxProtocolOperation;
      const prepared = await broker.prepareAction(snapshot, sandboxId, operation, input);
      expect(prepared.hostContractMinor).toBe(legacyProducer ? 0 : 1);
      const requestTransport = async (workerCommand: IncusTransportRequest) => {
        const result = await broker.request(prepared, { command: workerCommand }, Number(input.rpcDeadlineMs)) as { ok: boolean; result?: unknown; error?: { kind: ConstructorParameters<typeof IncusTransportError>[0]; effect: "none" | "unknown"; operationId?: string } };
        if (!result.ok) throw new IncusTransportError(result.error!.kind, "Host broker denied transport", { effect: result.error!.effect, operationId: result.error!.operationId });
        if (legacyProducer) {
          compileValueSchema(sandboxProviderMethodSchemas(operation, 0).outputSchema)(result.result);
          if (result.result && typeof result.result === "object" && "receipt" in result.result) expect((result.result as { receipt: object }).receipt).not.toHaveProperty("terminalObservation");
        }
        return result.result;

      };
      if (lostReturnPhase) return invokeActualAdapterWorker(prepared.expectedCommand.pins, operation, input, requestTransport, lose => { loseWorkerReturn = lose; });
      return new IncusSandboxAdapter(prepared.expectedCommand.pins, { request: requestTransport }).invoke(operation, input);
    } }));
    await controller.createBinding({ id: sandboxId, projectId: "project", providerInstallationId: "installation-a", providerReleaseId: "release-a",
      connectionId: "connection-a", connectionRevision: 1, resourceKey: sandboxId, profile: preset.profile, presetId: preset.id,
      presetDigest, effectiveSettingsDigest: "b".repeat(64) });
    await new SandboxAdmissionStore(db).configureHostCapacity({ providerInstallationId: "installation-a", connectionId: "connection-a",
      allocatable: { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis, pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
    await db.insert(schema.sandboxReservations).values({ bindingId: sandboxId, projectId: "project", providerInstallationId: "installation-a",
      connectionId: "connection-a", generation: 1, memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
      pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1, computeState: "RESERVED", diskState: "RESERVED" });
    if (fault) await db.insert(schema.incusQualificationFixtures).values({ operationId: "qual-recovery-composed", projectId: "project", bindingId: sandboxId, installationId: "installation-a", releaseId: "release-a", connectionId: "connection-a", connectionRevision: 1, presetId: preset.id, presetDigest, effectiveSettingsDigest: "b".repeat(64) });
    const sequence = ["CREATE", "START", "STOP", "START", "STOP", "DESTROY"] as const;
    for (const [index, kind] of sequence.entries()) {
      if (kind === "DESTROY" && fault) {
        armedDestroyId = crypto.randomUUID();
        const arm = { runId: "composed", nonce: "nonce-composed", deadlineMs: faultNow + 25_000,
          scope: { installationId: "installation-a", releaseId: "release-a", connectionId: "connection-a", presetId: preset.id }, fixtureOperationId: "qual-recovery-composed", bindingId: sandboxId, destroyOperationId: armedDestroyId, generation: 1, providerGeneration: 5, connectionRevision: 1 };
        await fault.arm(arm);
        await fault.assertArmedFor(arm);
      }
      const request = { bindingId: sandboxId, generation: 1, kind, idempotencyScope: kind === "DESTROY" && fault ? "incus-qualification" : "actual-adapter", idempotencyKey: kind === "DESTROY" && fault ? "qual-recovery-composed:destroy" : String(index),
        payload: kind === "CREATE" ? { profile: preset.profile, presetId: preset.id, presetDigest, effectiveSettingsDigest: "b".repeat(64) }
          : { expectedGeneration: Number(instance!.config["user.ezharness.generation"]) } };
      const journal = kind === "DESTROY" && fault
        ? await controller.executeOperation((await controller.journalOperation(request, armedDestroyId)).id)
        : await controller.requestAndDispatch(request);
      if (lostReturnPhase) {
        expect(journal.state).toBe(lostReturnPhase === "accepted" ? "OUTCOME_UNKNOWN" : "FAILED");
        expect(journal.providerOperationId).toBe("incus-create-11111111-1111-1111-1111-000000000001");
        expect(writes.filter(value => value.startsWith("POST"))).toHaveLength(1);
        expect(writes.some(value => value.startsWith("PUT"))).toBe(false);
        const reservations = await db.select().from(schema.sandboxReservations);
        expect(reservations[0]).toMatchObject({ computeState: "RESERVED", diskState: "RESERVED" });
        return;
      }
      if (kind === failureKind || failureKind === "PATCH" && kind === "START") {
        expect(journal).toMatchObject({ state: "FAILED", errorCode: "INTERNAL",
          providerOperationId: `incus-${kind === "CREATE" ? "create" : failureKind === "PATCH" ? "setPowerIntent" : "setPower"}-11111111-1111-1111-1111-${String(nativeSequence).padStart(12, "0")}` });
        expect(journal.errorMessage).toBe("Incus native lifecycle operation failed");
        if (failureKind === "PATCH") expect(writes.some(value => value.startsWith("PUT"))).toBe(false);
        const before = writes.length;
        expect((await controller.requestAndDispatch(request)).id).toBe(journal.id);
        expect(writes).toHaveLength(before);
        const reservations = await db.select().from(schema.sandboxReservations);
        expect(reservations[0]).toMatchObject({ computeState: "RESERVED", diskState: "RESERVED" });
        expect((await controller.getBinding(sandboxId))?.cleanupConfirmedAt).toBeNull();
        return;
      }
      if (slowCreate && kind === "CREATE") {
        expect(["PROVIDER_PENDING", "SUCCEEDED"]).toContain(journal.state);
        await broker.awaitObservation(journal.id);
        if (resumeCreate) {
          await broker.stopObservations();
          const replacement = new ProviderRpcBroker(connections, undefined, db, actionTransportFactory, undefined,
            { resolveActiveRelease: async () => snapshot });
          observationBroker = replacement;
          await replacement.resumePendingObservations();
          await replacement.awaitObservation(journal.id);
          expect((await controller.getOperation(journal.id))?.state).toBe("SUCCEEDED");
          expect((await controller.getBinding(sandboxId))?.observedState).toBe("STOPPED");
          expect(writes.filter(value => value.startsWith("POST"))).toHaveLength(1);
          expect(writes.some(value => value.startsWith("PUT"))).toBe(false);
          expect(createWaits).toBe(2);
          return;
        }
        expect(createWaits).toBe(2);
      } else expect({ kind, state: journal.state, error: journal.errorMessage }).toMatchObject({ state: kind === "DESTROY" && faultMode === "consume" ? "OUTCOME_UNKNOWN" : pendingCreate || legacyProducer || slowCreate && kind === "CREATE" ? "PROVIDER_PENDING" : "SUCCEEDED" });
      if (kind === "DESTROY" && fault) {
        expect(journal.providerOperationId).toBe("incus-destroy-11111111-1111-1111-1111-000000000006");
        expect(destroyInspections).toBe(faultMode === "consume" ? 2 : 3);
        expect(fault.matches({ ...command, action: "instance.destroy", idempotency: { requestId: armedDestroyId, key: armedDestroyId }, payload: { expectedGeneration: 5 } }, scope)).toBe(false);
        expect((await controller.getOperation(journal.id))?.state).toBe(journal.state);
      }
      await controller.reconcile();
      if (pendingCreate && kind === "CREATE") {
        expect((await controller.getOperation(journal.id))?.state).toBe("PROVIDER_PENDING");
        expect((await controller.getBinding(sandboxId))?.observedState).toBe("UNKNOWN");
        expect(writes.some(value => value.startsWith("PUT"))).toBe(false);
        return;
      }
      if (kind === "DESTROY" && fault) {
        expect((await controller.getOperation(journal.id))?.state).toBe(journal.state);
        await controller.reconcile(1, journal.id);
      }
      const saved = await db.query.sandboxOperations.findFirst({ where: (row, { eq }) => eq(row.id, journal.id) });
      expect(saved?.state).toBe("SUCCEEDED");
      const binding = await controller.getBinding(sandboxId);
      expect(binding?.generation).toBe(1);
      expect(binding?.observedState).toBe(kind === "DESTROY" ? "ABSENT" : kind === "START" ? "RUNNING" : "STOPPED");
      if (instance) expect(Number(instance.config["user.ezharness.generation"])).toBe(index + 1);
      if (kind === "START") {
        const inspection = await broker.prepareAction(snapshot, sandboxId, "lifecycle.inspect", {
          providerId: "incus", connectionId: "connection-a", sandboxId, rpcDeadlineMs: Date.now() + 30_000 });
        const transport = new HostIncusLifecycleTransport(connections, { providerInstallationId: inspection.installationId,
          providerReleaseId: inspection.releaseId, revision: inspection.revision, approvedPreset: inspection.approvedPreset }, fetcher as never);
        const before = writes.length;
        await expect(transport.request({ ...inspection.expectedCommand, action: "instance.destroy",
          idempotency: { requestId: `refused-${index}`, key: `refused-${index}` },
          payload: { expectedGeneration: index + 1 } })).rejects.toMatchObject({ kind: "revision_conflict", effect: "none" });
        expect(writes).toHaveLength(before);
        expect(instance?.status).toBe("Running");
        expect(Number(instance?.config["user.ezharness.generation"])).toBe(index + 1);
      }
    }
    expect(instance).toBeUndefined();
    expect(writes.filter(value => value.startsWith("PUT"))).toHaveLength(4);
    expect(writes.filter(value => value.startsWith("DELETE"))).toHaveLength(1);
  } finally { await observationBroker?.stopObservations(); await database.close(); }
}

test("real adapter and controller preserve the host fence across a complete power lifecycle", () => exerciseAdapterLifecycle());
test("delayed native destroy receipt through the real broker and adapter persists consumed fault as UNKNOWN", () => exerciseAdapterLifecycle("consume"));
test("expired fault cannot suppress a delayed native destroy receipt or fabricate UNKNOWN", () => exerciseAdapterLifecycle("expire"));


test("async CREATE keeps the native completion barrier while its stopped instance is visible", async () => {
  const nativeId = "11111111-1111-4111-8111-111111111111";
  let instance: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.includes("/profiles/")) return reply(safeProfile);
    if (path.includes("/operations/")) return reply({ status: "Running", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body));
      instance = { ...body, status: "Stopped", config: { ...body.config, "volatile.base_image": "c".repeat(64) } };
      return reply({ id: nativeId }, 202);
    }
    return instance ? reply(instance) : reply({}, 404);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const created = await transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    payload: { ...command.payload as object, desiredState: "stopped" } }) as { receipt: { operationId: string } };
  expect(created.receipt.operationId).toBe(`incus-create-${nativeId}`);
  const inspected = await transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "operation.inspect", payload: { operationId: created.receipt.operationId } }) as { operation: { state: string } };
  expect(inspected.operation.state).toBe("running");
  expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
  expect(calls.some(call => call.startsWith("PUT"))).toBe(false);
});

test("async intent PATCH must finish before the native power PUT", async () => {
  const calls: string[] = [];
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.profile": "linux-exec.v1",
    "user.ezharness.preset_id": "incus-linux-exec-v1", "user.ezharness.generation": "1" } };
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.includes("/operations/")) return reply({ status: "Running", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    if (init.method === "GET") return Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"revision-a"' } });
    return reply({ id: "22222222-2222-4222-8222-222222222222" }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  await expect(transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "instance.setPower", payload: { desiredState: "running", expectedGeneration: 1 } })).rejects.toMatchObject({ effect: "unknown" });
  expect(calls.some(call => call.startsWith("PUT"))).toBe(false);
  expect(calls.filter(call => call.startsWith("PATCH"))).toHaveLength(1);
});


test("real broker adapter and controller do not settle a visible instance before native CREATE completes", () => exerciseAdapterLifecycle(undefined, true));


test("real native CREATE failure is durably retained without releasing reservations or replay", () => exerciseAdapterLifecycle(undefined, false, "CREATE"));
test("real native START failure is durably retained without releasing reservations or replay", () => exerciseAdapterLifecycle(undefined, false, "START"));

test("a pending async PATCH waits once for terminal success before power dispatch", async () => {
  let release!: () => void;
  let ready!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const calls: string[] = [];
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.generation": "1" } };
  const patchId = "22222222-2222-4222-8222-222222222222";
  const powerId = "33333333-3333-4333-8333-333333333333";
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.includes(patchId)) { ready(); await barrier; return reply({ status: "Success", resources: { instances: [`/1.0/instances/${sandboxName}`] } }); }
    if (path.includes(powerId)) return reply({}, 404);
    if (init.method === "GET") return Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"revision-a"' } });
    return reply({ id: init.method === "PATCH" ? patchId : powerId }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const operation = transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "instance.setPower", payload: { desiredState: "running", expectedGeneration: 1 } });
  await entered;
  expect(calls.some(call => call.startsWith("PUT"))).toBe(false);
  release();
  expect(await operation).toMatchObject({ receipt: { operationId: `incus-setPower-${powerId}` } });
  expect(calls.filter(call => call.startsWith("PATCH"))).toHaveLength(1);
  expect(calls.filter(call => call.startsWith("PUT"))).toHaveLength(1);
});


test("terminal PATCH failure retains its accepted native handle and never dispatches power", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const writes: string[] = [];
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.generation": "1" } };
  const fetcher = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.includes("/operations/")) return reply({ status: "Failure", err: "secret provider detail",
      resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    if (init.method === "GET") return Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"revision-a"' } });
    writes.push(init.method!);
    return reply({ id }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const result = await transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "instance.setPower", payload: { desiredState: "running", expectedGeneration: 1 } });
  expect(result).toMatchObject({ receipt: { operationId: `incus-setPowerIntent-${id}`, terminalObservation: {
    state: "failed", observedState: "unknown", error: { code: "INTERNAL", retryable: false } } } });
  expect(JSON.stringify(result)).not.toContain("secret provider detail");
  expect(writes).toEqual(["PATCH"]);
});

test("native wait expiry, pending and transport loss retain one accepted CREATE identity", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const waitReply of ["missing", "pending", "lost"] as const) {
    let posts = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes("/operations/")) {
        if (waitReply === "lost") throw new Error("lost wait response");
        return waitReply === "missing" ? reply({}, 404) : reply({ status: "Running", resources: { instances: [`/1.0/instances/${sandboxName}`] } });
      }
      if (path.includes("/profiles/")) return reply(safeProfile);
      if (init.method === "POST") { posts++; return reply({ id }, 202); }
      return reply({}, 404);
    };
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
    const accepted = await transport.request({ ...command, deadlineMs: Date.now() + 30_000 });
    expect(accepted).toMatchObject({ receipt: { operationId: `incus-create-${id}` } });
    expect((accepted as { receipt: object }).receipt).not.toHaveProperty("terminalObservation");
    expect(posts).toBe(1);
  }
});

test("an async CREATE without a native handle cannot become a synthetic successful CREATE", async () => {
  let posts = 0;
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope,
    (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.includes("/profiles/")) return reply(safeProfile);
      if (init.method === "POST") { posts++; return reply({}, 202); }
      return reply({}, 404);
    }) as never);
  await expect(transport.request({ ...command, deadlineMs: Date.now() + 30_000 })).rejects.toMatchObject({ effect: "unknown", operationId: undefined });
  expect(posts).toBe(1);
});


test("frozen host 4.0 adapter receipt contract remains valid through normal stopped cleanup on a new host", () => exerciseAdapterLifecycle(undefined, false, undefined, true));


test("an actual adapter worker lost after native acceptance retains the durable handle", () => exerciseAdapterLifecycle(undefined, true, undefined, false, "accepted"));
test("an actual adapter worker lost after terminal failure capture retains the durable failure", () => exerciseAdapterLifecycle(undefined, false, "CREATE", false, "terminal"));


test("real broker persists terminal PATCH failure under its native handle without dispatching power", () => exerciseAdapterLifecycle(undefined, false, "PATCH"));


test("pending power intent retains its distinct native handle and later PATCH success never settles power", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  let nativeStatus = "Running";
  const writes: string[] = [];
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a",
    "user.ezharness.sandbox_id": sandboxId, "user.ezharness.generation": "1" } };
  const fetcher = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.includes("/operations/")) return reply({ status: nativeStatus,
      resources: { instances: [`/1.0/instances/${sandboxName}`] } });
    if (init.method === "GET") return Response.json({ type: "sync", metadata: instance }, { headers: { etag: '"revision-a"' } });
    writes.push(init.method!);
    return reply({ id }, 202);
  };
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope, fetcher as never);
  const intentId = `incus-setPowerIntent-${id}`;
  await expect(transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "instance.setPower", payload: { desiredState: "running", expectedGeneration: 1 } })).rejects.toMatchObject({
      effect: "unknown", operationId: intentId });
  nativeStatus = "Success";
  const inspected = await transport.request({ ...command, deadlineMs: Date.now() + 30_000,
    action: "operation.inspect", payload: { operationId: intentId } });
  expect(inspected).toMatchObject({ operation: { operationId: intentId, kind: "setPower", state: "outcome_unknown", observedState: "unknown" } });
  expect(writes).toEqual(["PATCH"]);
});


test("known native cancellation stays terminal and rejects foreign resource identity", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const resource of [sandboxName, "foreign-sandbox"]) {
    const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => connection }, scope,
      (async () => reply({ status: "Cancelled", resources: { instances: [`/1.0/instances/${resource}`] } })) as never);
    const operation = transport.request({ ...command, deadlineMs: Date.now() + 30_000,
      action: "operation.inspect", payload: { operationId: `incus-create-${id}` } });
    if (resource === sandboxName) await expect(operation).resolves.toMatchObject({ operation: {
      state: "cancelled", observedState: "unknown", error: { code: "INTERNAL", retryable: false } } });
    else await expect(operation).rejects.toMatchObject({ kind: "permission" });
  }
});


test("a slow CREATE terminal result is captured before the normal reconciliation receipt has expired", () =>
  exerciseAdapterLifecycle(undefined, false, undefined, false, undefined, true));


test("a replacement host resumes the saved CREATE observer without replaying its mutation", () =>
  exerciseAdapterLifecycle(undefined, false, undefined, false, undefined, true, true));


test("real async PATCH intent advances to one final power receipt only after its successful barrier", () =>
  exerciseAdapterLifecycle(undefined, false, "PATCH_SUCCESS"));
