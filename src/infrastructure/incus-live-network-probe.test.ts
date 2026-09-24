import { afterAll, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import recipeValue from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import type { Database } from "../db/connection";
import { incusQualificationFixtures } from "../db/schema";
import { ReleaseProcess } from "../extensions/release-process";
import { resourceName } from "./incus-transport/lifecycle";
import type { LiveReadbackContext } from "./incus-transport/live-readback";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { connectHostTarget, IncusLiveNetworkProbe, invokeProtectedIncusGuest } from "./incus-live-network-probe";

const certs = makeTestCertificates();
afterAll(() => certs.dispose());
const recipe = recipeValue as IncusSetupRecipe;
const preset = INCUS_PRESETS[0]!;
const neighbor = { sandboxId: "neighbor-binding", operationId: "neighbor-operation" };
const address = "10.173.0.12";
const connection = { endpoint: "https://127.0.0.1:8443", serverCertificatePem: certs.read("server-cert.pem"),
  project: recipe.project.name, clientCertificatePem: certs.read("client-cert.pem"),
  privateKeyPem: certs.read("client-key.pem") };
const envelope = (metadata: unknown) => Response.json({ type: "sync", status_code: 200, metadata });

async function setup(overrides: { fixture?: Record<string, unknown>; binding?: Record<string, unknown>;
  instance?: Record<string, unknown>; state?: Record<string, unknown>; portOutput?: string;
  hostReachable?: boolean; delayPort?: boolean } = {}) {
  const context: LiveReadbackContext = {
    scope: { installationId: "installation", releaseId: "release", connectionId: "connection" },
    connection: { revision: 1, project: recipe.project.name,
      serverCertificatePem: connection.serverCertificatePem,
      configuration: { profile: recipe.profile.name, helperVersion: "0.1.0", guestUser: "sandbox" } },
    preset, presetDigest: await sandboxPresetDigest(preset), effectiveSettingsDigest: "a".repeat(64), recipe,
  };
  const fixture = { operationId: neighbor.operationId, bindingId: neighbor.sandboxId,
    installationId: context.scope.installationId, releaseId: context.scope.releaseId,
    connectionId: context.scope.connectionId, connectionRevision: 1, presetId: preset.id,
    presetDigest: context.presetDigest, effectiveSettingsDigest: context.effectiveSettingsDigest,
    projectId: "fixture-project", ...overrides.fixture };
  const binding = { id: neighbor.sandboxId, resourceKey: neighbor.sandboxId,
    projectId: fixture.projectId, providerInstallationId: fixture.installationId,
    providerReleaseId: fixture.releaseId, connectionId: fixture.connectionId,
    connectionRevision: fixture.connectionRevision, presetId: fixture.presetId,
    presetDigest: fixture.presetDigest, effectiveSettingsDigest: fixture.effectiveSettingsDigest,
    desiredState: "RUNNING", observedState: "RUNNING", tombstonedAt: null, ...overrides.binding };
  const name = resourceName(context.scope.connectionId, neighbor.sandboxId);
  const instance = { name, type: "container", status: "Running", profiles: [recipe.profile.name],
    config: { "user.ezharness.managed_by": "ezharness-incus-sandbox",
      "user.ezharness.connection_id": context.scope.connectionId,
      "user.ezharness.sandbox_id": neighbor.sandboxId,
      "user.ezharness.profile": preset.profile, "user.ezharness.preset_id": preset.id,
      "volatile.base_image": preset.imageDigest },
    expanded_devices: { eth0: { type: "nic", network: recipe.network.name,
      "security.port_isolation": "true" }, root: recipe.profile.devices.root }, ...overrides.instance };
  const state = { status: "Running", network: { eth0: { addresses: [{ family: "inet",
    scope: "global", address }] } }, ...overrides.state };
  const paths: string[] = [];
  const operations: string[] = [];
  let outputReads = 0;
  const checked: Array<{ address: string; port: number; expected?: string }> = [];
  const probe = new IncusLiveNetworkProbe({
    db: { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
      table === incusQualificationFixtures ? [fixture] : [binding] }) }) }) } as unknown as Database,
    connections: { resolveForHost: async () => connection },
    http: (async (url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === `/1.0/instances/${name}`) return envelope(instance);
      if (path === `/1.0/instances/${name}/state`) return envelope(state);
      throw new Error(`unexpected path ${path}`);
    }) as never,
    invokeGuest: async (installationId, bindingId, operation, input) => {
      expect(installationId).toBe(context.scope.installationId);
      expect(bindingId).toBe(neighbor.sandboxId);
      expect(input.sandboxId).toBe(neighbor.sandboxId);
      operations.push(operation);
      if (operation === "processes.start") {
        expect(input.user).toBe("sandbox");
        expect((input.argv as string[])[0]).toBe("python3");
        return { ok: true, processId: "process-1", bootId: "boot-1",
          startedAt: "2026-09-23T12:00:00.000Z" };
      }
      if (operation === "processes.readOutput") {
        if (overrides.delayPort && outputReads++ === 0) return { ok: true, chunks: [],
          nextCursor: { sandboxId: neighbor.sandboxId, processId: "process-1",
            bootId: "boot-1", offsetBytes: 0 }, eof: false };
        const output = overrides.portOutput ?? "43721\n";
        return { ok: true, chunks: [{ stream: "stdout", offsetBytes: 0,
          byteLength: output.length, dataBase64: Buffer.from(output).toString("base64") }],
          nextCursor: { sandboxId: neighbor.sandboxId, processId: "process-1",
            bootId: "boot-1", offsetBytes: output.length }, eof: false };
      }
      throw new Error("unexpected operation");
    },
    connect: async (target, expected) => {
      checked.push({ ...target, expected });
      return overrides.hostReachable ?? true;
    },
  });
  return { probe, context, paths, operations, checked };
}

test("derives exact running neighbor address and protected listener port, then proves host reachability", async () => {
  const { probe, context, paths, operations, checked } = await setup();
  const target = await probe.neighborTarget(context, neighbor);
  expect(target).toEqual({ sandboxId: neighbor.sandboxId, address, port: 43721 });
  expect(paths).toEqual([`/1.0/instances/${resourceName(context.scope.connectionId, neighbor.sandboxId)}`,
    `/1.0/instances/${resourceName(context.scope.connectionId, neighbor.sandboxId)}/state`]);
  expect(operations).toEqual(["processes.start", "processes.readOutput"]);
  expect(await probe.hostCanConnect(target)).toBe(true);
  expect(await probe.hostCanConnect(target)).toBe(true);
  expect(checked[0]?.expected).toMatch(/^[a-f0-9]{48}$/);
  expect(checked[1]?.expected).toBe(checked[0]?.expected);
});

test("a concurrent listener cannot replace an earlier target's challenge", async () => {
  const { probe, context, checked } = await setup();
  const first = await probe.neighborTarget(context, neighbor);
  expect(await probe.hostCanConnect(first)).toBe(true);
  const second = await probe.neighborTarget(context, neighbor);
  expect(await probe.hostCanConnect(first)).toBe(false);
  expect(await probe.hostCanConnect({ ...second })).toBe(false);
  expect(await probe.hostCanConnect(second)).toBe(true);
  expect(checked).toHaveLength(2);
  expect(checked[1]?.expected).not.toBe(checked[0]?.expected);
});

test("rejects durable identity and running-state drift before backend or guest access", async () => {
  for (const overrides of [
    { fixture: { connectionId: "other" } },
    { binding: { observedState: "STOPPED" } },
    { binding: { resourceKey: "other" } },
    { binding: { tombstonedAt: new Date() } },
  ]) {
    const { probe, context, paths, operations } = await setup(overrides);
    await expect(probe.neighborTarget(context, neighbor)).rejects.toThrow("neighbor");
    expect(paths).toHaveLength(0);
    expect(operations).toHaveLength(0);
  }
});

test("rejects a forged backend identity, extra NIC, and address outside the reviewed bridge", async () => {
  for (const overrides of [
    { instance: { status: "Stopped" } },
    { instance: { expanded_devices: { eth0: recipe.profile.devices.eth0,
      root: recipe.profile.devices.root, eth1: recipe.profile.devices.eth0 } } },
    { state: { network: { eth0: { addresses: [{ family: "inet", scope: "global",
      address: "192.168.1.3" }] } } } },
  ]) {
    const { probe, context, operations } = await setup(overrides);
    await expect(probe.neighborTarget(context, neighbor)).rejects.toThrow();
    expect(operations).toHaveLength(0);
  }
});

test("rejects a malformed listener port and reports failed host control", async () => {
  const bad = await setup({ portOutput: "0\n" });
  await expect(bad.probe.neighborTarget(bad.context, neighbor)).rejects.toThrow("port");
  const unreachable = await setup({ hostReachable: false });
  const target = await unreachable.probe.neighborTarget(unreachable.context, neighbor);
  expect(await unreachable.probe.hostCanConnect(target)).toBe(false);
});

test("waits for a protected listener port without accepting an empty first read", async () => {
  const delayed = await setup({ delayPort: true });
  expect(await delayed.probe.neighborTarget(delayed.context, neighbor)).toMatchObject({ port: 43721 });
  expect(delayed.operations).toEqual(["processes.start", "processes.readOutput", "processes.readOutput"]);
});

test("production host control opens a real TCP connection and fails closed after shutdown", async () => {
  const server = createServer(socket => socket.end("verified-token"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = server.address();
  expect(endpoint).not.toBeNull();
  const target = { address: "127.0.0.1", port: typeof endpoint === "string" ? 0 : endpoint!.port };
  const probe = new IncusLiveNetworkProbe({ db: {} as Database });
  try {
    expect(await probe.hostCanConnect(target)).toBe(true);
    expect(await connectHostTarget(target, "verified-token")).toBe(true);
    expect(await connectHostTarget(target, "wrong-token")).toBe(false);
  }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  expect(await probe.hostCanConnect(target)).toBe(false);
  expect(await probe.hostCanConnect({ address: "not-an-ip.example", port: 443 })).toBe(false);
  expect(await probe.hostCanConnect({ address: "127.0.0.1", port: 0 })).toBe(false);
});

test("production guest path calls the protected release and settles it", async () => {
  const call = spyOn(ReleaseProcess.prototype, "callIncusSandboxOperation")
    .mockResolvedValue({ result: { ok: true } } as never);
  const kill = spyOn(ReleaseProcess.prototype, "kill").mockImplementation(() => {});
  const settled = spyOn(ReleaseProcess.prototype, "whenCallsSettled").mockResolvedValue();
  try {
    expect(await invokeProtectedIncusGuest("installation", neighbor.sandboxId,
      "processes.inspect", { sandboxId: neighbor.sandboxId })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith(neighbor.sandboxId, "processes.inspect",
      { sandboxId: neighbor.sandboxId });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  } finally { call.mockRestore(); kill.mockRestore(); settled.mockRestore(); }
});

test("challenge control fails when the peer closes or stalls before the token", async () => {
  const run = async (respond: (socket: import("node:net").Socket) => void) => {
    const server = createServer(respond);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = server.address();
    expect(endpoint).not.toBeNull();
    const target = { address: "127.0.0.1", port: typeof endpoint === "string" ? 0 : endpoint!.port };
    try { return await connectHostTarget(target, "verified-token"); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  };
  expect(await run(socket => socket.end())).toBe(false);
  expect(await run(() => {})).toBe(false);
});
