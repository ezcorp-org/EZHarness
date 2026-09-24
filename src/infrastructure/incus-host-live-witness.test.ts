import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import recipe from "../../scripts/incus/recipe.json";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import type { Database } from "../db/connection";
import { incusQualificationFixtures } from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { IncusHostLiveWitness, incusHostLiveWitnessReady } from "./incus-host-live-witness";
import { IncusLiveNetworkProbe } from "./incus-live-network-probe";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import type { ProviderConnectionCredentials } from "./provider-connections/store";

const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
  presetId: INCUS_PRESETS[0]!.id };
const handle = { sandboxId: "fixture-binding", operationId: "fixture-operation" };
const witness = new IncusHostLiveWitness({ db: {} as Database,
  qualifications: {} as IncusQualificationStore,
  fixtures: {} as IncusQualificationFixtureService });

test("production qualification remains closed without operator wiring", async () => {
  expect(await incusHostLiveWitnessReady({ env: {} })).toBe(false);
  expect((witness as unknown as { resourceNetwork: unknown }).resourceNetwork)
    .toBeInstanceOf(IncusLiveNetworkProbe);
});

test("live readiness requires private host wiring and exact supervisor protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "ezh-live-gate-"));
  const socket = join(root, "control.sock");
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const env = { EZCORP_INCUS_CONTROL_PROBE_ROOT: root,
    EZCORP_INCUS_SUPERVISOR_SOCKET: socket,
    EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID: "reviewed-project",
    EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF: `registry.example/proof@sha256:${"a".repeat(64)}`,
    EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: key };
  let response = { ready: true, protocol: "incus-qualification.v1" };
  const server = createServer(connection => {
    let request = "";
    connection.on("data", chunk => {
      request += chunk.toString();
      if (!request.includes("\n")) return;
      expect(JSON.parse(request)).toEqual({ version: 1, action: "readiness" });
      connection.end(`${JSON.stringify(response)}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once("error", reject));
    expect(await incusHostLiveWitnessReady({ env })).toBe(true);
    const { EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: _inlineKey, ...singleLineEnv } = env;
    expect(await incusHostLiveWitnessReady({ env: { ...singleLineEnv,
      EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64: Buffer.from(key).toString("base64") } })).toBe(true);
    response = { ready: true, protocol: "wrong" };
    expect(await incusHostLiveWitnessReady({ env })).toBe(false);
    expect(await incusHostLiveWitnessReady({ env: { ...env,
      EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF: "registry.example/proof:latest" } })).toBe(false);
    expect(await incusHostLiveWitnessReady({ env: { ...env,
      EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: "not a key" } })).toBe(false);
    expect(await incusHostLiveWitnessReady({ env: { ...env,
      EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID: "../other" } })).toBe(false);
    await chmod(root, 0o750);
    expect(await incusHostLiveWitnessReady({ env })).toBe(false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("every unmeasured host probe denies instead of reporting a passing fact", async () => {
  const preset = INCUS_PRESETS[0]!;
  for (const call of [
    () => witness.controlFacts(scope, preset),
    () => witness.restartController(handle),
    () => witness.exerciseFailedCleanupRecovery(handle, handle),
  ]) await expect(call()).rejects.toThrow("Incus live witness unavailable");
  await expect(witness.exerciseLimits(handle, handle)).rejects.toThrow("two distinct running fixtures");
  await expect(witness.observeEnforcement(handle, handle)).rejects.toThrow("two distinct fixtures");
});

test("cleanup witness reads durable fault, real readiness denial, and same-operation recovery", async () => {
  const other = { sandboxId: "other-binding", operationId: "other-operation" };
  let phase = 0;
  const calls: string[] = [];
  const status = (value: typeof handle) => ({
    fixture: { ...scope, operationId: value.operationId, bindingId: value.sandboxId,
      projectId: `project-${value.sandboxId}`, connectionRevision: 1 },
    binding: { id: value.sandboxId, generation: 1,
      desiredState: value.sandboxId === handle.sandboxId && phase > 0 ? "ABSENT" : "STOPPED",
      observedState: value.sandboxId === handle.sandboxId && phase === 2 ? "ABSENT" : "STOPPED" },
    operation: { id: value.sandboxId === handle.sandboxId && phase > 0 ? "destroy-one" : "create-one",
      kind: value.sandboxId === handle.sandboxId && phase > 0 ? "DESTROY" : "CREATE",
      state: value.sandboxId === handle.sandboxId && phase === 1 ? "OUTCOME_UNKNOWN" : "SUCCEEDED",
      generation: 1 },
  });
  const candidate = new IncusHostLiveWitness({ db: {} as Database,
    qualifications: {} as IncusQualificationStore,
    fixtures: { status: async (_scope: typeof scope, operationId: string) =>
      status(operationId === handle.operationId ? handle : other) } as unknown as IncusQualificationFixtureService,
    cleanupRecovery: {
      injectLostDestroyReply: async (seenScope, seenHandle) => {
        expect(seenScope).toEqual(scope); expect(seenHandle).toEqual(handle);
        calls.push("fault"); phase = 1; throw new Error("reply lost");
      },
      attemptReadiness: async (seenScope, seenHandle) => {
        expect(seenScope).toEqual(scope); expect(seenHandle).toEqual(handle);
        calls.push("ready"); throw Object.assign(new Error("cleanup pending"),
        { code: "QUALIFICATION_CLEANUP_UNVERIFIED" }); },
      reconcileFromReopenedController: async (seenScope, seenHandle) => {
        expect(seenScope).toEqual(scope); expect(seenHandle).toEqual(handle);
        calls.push("reopen"); phase = 2;
      },
    },
  });
  const internal = candidate as unknown as {
    owned: (value: typeof handle) => Promise<unknown>;
    context: () => Promise<unknown>;
    assertDurableState: (value: typeof handle, _scope: typeof scope, state: string) => Promise<void>;
  };
  internal.owned = async value => ({ scope, selected: { preset: INCUS_PRESETS[0]! }, binding: { id: value.sandboxId } });
  internal.context = async () => ({ context: {} });
  internal.assertDurableState = async (value, _scope, state) => { calls.push(`${value.sandboxId}:${state}`); };
  candidate.inspectFixture = async value => ({ sandboxId: value.sandboxId,
    state: value.sandboxId === handle.sandboxId ? "absent" : "stopped" }) as Awaited<
      ReturnType<IncusHostLiveWitness["inspectFixture"]>>;
  expect(await candidate.exerciseFailedCleanupRecovery(handle, other)).toEqual({
    firstDestroyOperationId: "destroy-one", recordedState: "RECONCILE_REQUIRED",
    readinessErrorCode: "QUALIFICATION_CLEANUP_UNVERIFIED", reconciledOperationId: "destroy-one",
    finalState: "absent", unrelatedState: "stopped",
  });
  expect(calls).toEqual(["fault", "ready", "reopen", `${handle.sandboxId}:ABSENT`, `${other.sandboxId}:STOPPED`]);
  await expect(candidate.exerciseFailedCleanupRecovery(handle, handle))
    .rejects.toThrow("two distinct fixtures");
});

test("observe requires exact verified setup and rejects forged backend artifact readback", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const connection = { revision: 1, configuration: { profile: "compose" } };
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } }, connection,
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  const observed = { observation: { backendApi: "incus.v1", backendVersion: "6.0.6",
    architecture: "amd64" as const, storageDriver: "btrfs", isolation: "container" as const,
    nestedCompose: true }, imageDigest: preset.imageDigest,
    helperDigest: preset.helperDigests[0]!, profile: preset.profile };
  const candidate = (receipt: typeof setup, image: typeof observed) => new IncusHostLiveWitness({
    db: {} as Database,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
    readSetup: async () => receipt,
    backend: { image: async () => image, instance: async () => ({ state: "absent" }) },
  });
  expect(await candidate(setup, observed).observe(scope, preset)).toEqual(observed);
  await expect(candidate({ ...setup, connectionId: "forged" }, observed).observe(scope, preset))
    .rejects.toThrow("verified setup");
  await expect(candidate(setup, { ...observed, imageDigest: "f".repeat(64) }).observe(scope, preset))
    .rejects.toThrow("backend artifact");
  await expect(candidate(setup, { ...observed, helperDigest: "f".repeat(64) }).observe(scope, preset))
    .rejects.toThrow("backend artifact");
});

test("default setup readback selects the saved host receipt", async () => {
  const preset = INCUS_PRESETS[0]!;
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } },
    connection: { revision: 1, configuration: { profile: "compose" } },
    preset, presetDigest: await sandboxPresetDigest(preset), effectiveSettingsDigest: "b".repeat(64) };
  const receipt = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  let reads = 0;
  const db = { execute: async () => { reads++; return { rows: [receipt] }; } } as unknown as Database;
  const candidate = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
    backend: { image: async () => ({ observation: { backendApi: "incus.v1", backendVersion: "6.0.6",
      architecture: "amd64", storageDriver: "btrfs", isolation: "container", nestedCompose: true },
      imageDigest: preset.imageDigest, helperDigest: preset.helperDigests[0]!, profile: preset.profile }),
    instance: async () => ({ state: "absent" }) },
  });
  expect((await candidate.observe(scope, preset)).imageDigest).toBe(preset.imageDigest);
  expect(reads).toBe(1);
});

test("control facts derive plan digests and reject allocation or canary changes", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64), manifest: incusManifest } },
    connection: { revision: 1, configuration: { profile: "compose" } },
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  const observation = { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64" as const,
    storageDriver: "btrfs", isolation: "container" as const, nestedCompose: true };
  const candidate = (fault: "none" | "allocation" | "canary" | "artifact" | "inventory") => {
    const seen = new Map<string, number>();
    return new IncusHostLiveWitness({ db: {} as Database,
      qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
      fixtures: {} as IncusQualificationFixtureService, readSetup: async () => setup,
      backend: { image: async () => ({ observation, imageDigest: preset.imageDigest,
        helperDigest: fault === "artifact" ? "f".repeat(64) : preset.helperDigests[0]!, profile: preset.profile }),
      instance: async () => ({ state: "absent" }) },
      controlProbe: {
        snapshot: async kind => {
          const count = seen.get(kind) ?? 0;
          seen.set(kind, count + 1);
          return { reservationIds: fault === "allocation" && kind === "drift" && count === 1
            ? ["new-reservation"] : fault === "inventory" ? ["same", "same"] : [],
            operationIds: [], backendIds: [], canaryIdentity: `canary-${kind}`,
            canaryBytes: new TextEncoder().encode(fault === "canary" && kind === "drift" && count === 1 ? "changed" : "safe") };
        },
        attempt: async kind => `DENIED_${kind.toUpperCase()}`,
      },
    });
  };
  const facts = await candidate("none").controlFacts(scope, preset);
  expect(facts.baselinePlanDigest).toBe(facts.repeatedPlanDigest);
  expect(facts.changedPlanDigest).not.toBe(facts.baselinePlanDigest);
  expect(facts.unsupportedAllocationDelta).toBe(0);
  expect(facts.localCanaryBefore).toBe(facts.localCanaryAfter);
  await expect(candidate("allocation").controlFacts(scope, preset)).rejects.toThrow("allocation readback changed");
  await expect(candidate("canary").controlFacts(scope, preset)).rejects.toThrow("distinct local canaries changed");
  await expect(candidate("artifact").controlFacts(scope, preset)).rejects.toThrow("backend artifact changed");
  await expect(candidate("inventory").controlFacts(scope, preset)).rejects.toThrow("control inventory identity is invalid");
});

test("inspection rejects a backend state that disagrees with the durable fixture", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } },
    connection: { revision: 1, configuration: { profile: "compose", guestUser: "sandbox" } },
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const fixture = { ...scope, operationId: handle.operationId, bindingId: handle.sandboxId,
    projectId: "project", connectionRevision: 1, presetDigest,
    effectiveSettingsDigest: selected.effectiveSettingsDigest };
  const binding = { id: handle.sandboxId, projectId: fixture.projectId, resourceKey: handle.sandboxId,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: selected.effectiveSettingsDigest, tombstonedAt: null as Date | null,
    observedState: "STOPPED", desiredState: "STOPPED" };
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === incusQualificationFixtures ? [fixture] : [binding],
  }) }) }) } as unknown as Database;
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  let authorized = true;
  const candidate = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => {
      if (!authorized) throw new Error("release unavailable");
      return selected;
    } } as unknown as IncusQualificationStore,
    fixtures: { destroy: async () => ({ state: "SUCCEEDED", kind: "DESTROY", bindingId: handle.sandboxId }),
      status: async () => ({ fixture, binding }) } as unknown as IncusQualificationFixtureService,
    readSetup: async () => setup,
    backend: { image: async () => { throw new Error("unused"); },
      instance: async () => ({ state: "absent" }) },
  });
  await expect(candidate.inspectFixture(handle)).rejects.toThrow("backend and durable fixture state disagree");
  binding.observedState = "ABSENT";
  binding.desiredState = "ABSENT";
  binding.tombstonedAt = new Date();
  expect(await candidate.inspectFixture(handle)).toMatchObject({ sandboxId: handle.sandboxId, state: "absent" });
  authorized = false;
  await candidate.destroyFixture(handle);
  await expect(candidate.setPower(handle, "running")).rejects.toThrow("fixture binding changed");
});

test("resource enforcement binds guest cgroups and network checks to two running fixtures", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const other = { sandboxId: "neighbor-binding", operationId: "neighbor-operation" };
  const fixture = (value: typeof handle) => ({ ...scope, operationId: value.operationId,
    bindingId: value.sandboxId, projectId: "project", connectionRevision: 1,
    presetDigest, effectiveSettingsDigest: "b".repeat(64) });
  const binding = (value: typeof handle) => ({ id: value.sandboxId, projectId: "project",
    resourceKey: value.sandboxId, providerInstallationId: scope.installationId,
    providerReleaseId: scope.releaseId, connectionId: scope.connectionId,
    connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: "b".repeat(64), tombstonedAt: null,
    observedState: "RUNNING", desiredState: "RUNNING" });
  let fixtureReads = 0;
  let bindingReads = 0;
  let targetId = other.sandboxId;
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === incusQualificationFixtures
      ? [fixture([handle, other][fixtureReads++]!)] : [binding([handle, other][bindingReads++]!)],
  }) }) }) } as unknown as Database;
  const selected = { snapshot: { release: { releaseDigest: "a".repeat(64) } },
    connection: { id: scope.connectionId, endpoint: "https://100.81.181.39:8443",
      revision: 1, configuration: { profile: "compose", guestUser: "sandbox" } },
    preset, presetDigest, effectiveSettingsDigest: "b".repeat(64) };
  const setup = { state: "verified", providerReleaseId: scope.releaseId,
    providerReleaseDigest: selected.snapshot.release.releaseDigest,
    connectionId: scope.connectionId, connectionRevision: 1, recipe: recipe as IncusSetupRecipe };
  const calls: string[] = [];
  const candidate = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
    readSetup: async () => setup,
    backend: { image: async () => { throw new Error("unused"); },
      instance: async (_context, sandboxId) => {
        calls.push(`backend:${sandboxId}`);
        return { state: "running", privateNetwork: true, diskBytes: preset.limits.diskBytes };
      } },
    resourceNetwork: {
      neighborTarget: async (_context, value) => {
        calls.push(`target:${value.sandboxId}`);
        return { sandboxId: targetId, address: "10.173.0.22", port: 8080 };
      },
      hostCanConnect: async target => {
        calls.push(`host:${target.address}:${target.port}`);
        return true;
      },
    },
  });
  candidate.run = async (value, argv) => {
    expect(value).toEqual(handle);
    expect(argv.slice(3)).toEqual(["100.81.181.39", "8443", "10.173.0.22", "8080"]);
    calls.push(`guest:${value.sandboxId}`);
    return { exitCode: 0, stdout: JSON.stringify({ memory: String(preset.limits.memoryBytes),
      cpu: `${preset.limits.cpuMillis * 100} 100000`, pids: String(preset.limits.pids),
      uidMap: "0 100000 65536\n", managementBlocked: true, otherSandboxBlocked: true }), stderr: "" };
  };
  expect(await candidate.observeEnforcement(handle, other)).toMatchObject({
    memoryMaxBytes: preset.limits.memoryBytes, cpuQuotaMillis: preset.limits.cpuMillis,
    pidsMax: preset.limits.pids, rootQuotaBytes: preset.limits.diskBytes,
    privateNetworkProbeBlocked: true,
  });
  expect(calls).toEqual([`backend:${handle.sandboxId}`, `backend:${other.sandboxId}`,
    `target:${other.sandboxId}`, "host:100.81.181.39:8443", "host:10.173.0.22:8080",
    `guest:${handle.sandboxId}`, "host:100.81.181.39:8443", "host:10.173.0.22:8080"]);
  await expect(candidate.observeEnforcement(handle, handle)).rejects.toThrow("two distinct fixtures");
  fixtureReads = 0;
  bindingReads = 0;
  targetId = "forged-neighbor";
  await expect(candidate.observeEnforcement(handle, other)).rejects.toThrow("neighbor network identity changed");
  expect(calls.filter(value => value.startsWith("guest:"))).toHaveLength(1);
});

test("discarded create reply must replay the same durable fixture operation", async () => {
  let calls = 0;
  let cleanups = 0;
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const service = { create: async () => ({ id: `operation-${++calls}`, bindingId: "binding" }),
    destroy: async () => { cleanups++; return { state: "SUCCEEDED" }; } };
  const candidate = new IncusHostLiveWitness({ db: {} as Database,
    qualifications: { authorizeFixture: async () => ({ preset, presetDigest }) } as unknown as IncusQualificationStore,
    fixtures: service as unknown as IncusQualificationFixtureService });
  await expect(candidate.createFixture(scope, preset, "fixture", true))
    .rejects.toThrow("replay allocated another fixture");
  expect(calls).toBe(2);
  expect(cleanups).toBe(1);
});

test("guest paths and process requests deny unsafe inputs before any fixture effect", async () => {
  for (const path of ["/etc/passwd", "../outside", "a//b", "a\\b", "a\0b"]) {
    await expect(witness.writeFile(handle, path, new Uint8Array([1]))).rejects.toThrow("invalid guest path");
    await expect(witness.readFile(handle, path)).rejects.toThrow("invalid guest path");
  }
  await expect(witness.writeFile(handle, "large", new Uint8Array(64 * 1024 + 1)))
    .rejects.toThrow("file exceeds one verified guest write");
  await expect(witness.run(handle, [], 1000)).rejects.toThrow("invalid guest process request");
  await expect(witness.run(handle, ["true"], 120_001)).rejects.toThrow("invalid guest process request");
});

test("fixture guest file and process calls use the exact running release and connection", async () => {
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const fixture = { ...scope, operationId: handle.operationId, bindingId: handle.sandboxId,
    projectId: "project", connectionRevision: 1, presetDigest,
    effectiveSettingsDigest: "b".repeat(64) };
  const binding = { id: handle.sandboxId, projectId: fixture.projectId, resourceKey: handle.sandboxId,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest: fixture.effectiveSettingsDigest, tombstonedAt: null,
    desiredState: "RUNNING", observedState: "RUNNING", generation: 1 };
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === incusQualificationFixtures ? [fixture] : [binding],
  }) }) }) } as unknown as Database;
  const selected = { connection: { revision: 1 }, preset, presetDigest,
    effectiveSettingsDigest: fixture.effectiveSettingsDigest };
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  let outputPages = 0;
  const candidate = new IncusHostLiveWitness({ db,
    qualifications: { authorizeFixture: async () => selected } as unknown as IncusQualificationStore,
    fixtures: {} as IncusQualificationFixtureService,
    activeRelease: async () => ({ installation: { id: scope.installationId,
      activeReleaseId: scope.releaseId }, release: { id: scope.releaseId } }) as ActiveExtensionRelease,
    resolveConnection: async () => ({ id: scope.connectionId, revision: 1, revokedAt: null,
      configuration: { kind: "incus", guestUser: "sandbox" } }) as ProviderConnectionCredentials,
    invokeGuest: async (_installation, _binding, operation, input) => {
      calls.push({ operation, input });
      if (operation === "files.writeAtomic") return { ok: true, path: input.path, revision: "r1", sizeBytes: 2 };
      if (operation === "files.stat") return { ok: true, file: { path: input.path, kind: "file",
        revision: "r1", sizeBytes: 2, executable: false } };
      if (operation === "files.readRange") return { ok: true, path: input.path, revision: "r1",
        offsetBytes: 0, dataBase64: "b2s=", byteLength: 2, eof: true };
      if (operation === "processes.start") return { ok: true, processId: "process-1", bootId: "boot-1",
        startedAt: "2026-09-23T12:00:00.000Z" };
      if (operation === "processes.readOutput") {
        const page = outputPages++;
        return { ok: true,
          chunks: [{ stream: "stdout", offsetBytes: page, dataBase64: page === 0 ? "bw==" : "aw==", byteLength: 1 }],
          nextCursor: { sandboxId: handle.sandboxId, processId: "process-1", bootId: "boot-1", offsetBytes: page + 1 },
          eof: page > 0 };
      }
      if (operation === "processes.inspect") return { ok: true,
        process: { processId: "process-1", sandboxId: handle.sandboxId, bootId: "boot-1",
          state: "succeeded", startedAt: "2026-09-23T12:00:00.000Z",
          finishedAt: "2026-09-23T12:00:01.000Z", exitCode: 0, signal: null } };
      throw new Error("unexpected operation");
    },
  });
  await candidate.writeFile(handle, "marker", new TextEncoder().encode("ok"));
  expect(new TextDecoder().decode(await candidate.readFile(handle, "marker"))).toBe("ok");
  expect(await candidate.run(handle, ["printf", "ok"], 30_000)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
  expect(calls.map(call => call.operation)).toEqual(["files.writeAtomic", "files.stat", "files.readRange",
    "processes.start", "processes.readOutput", "processes.inspect", "processes.readOutput", "processes.inspect"]);
  expect(calls.every(call => call.input.sandboxId === handle.sandboxId && call.input.connectionId === scope.connectionId))
    .toBe(true);
  binding.observedState = "STOPPED";
  await expect(candidate.readFile(handle, "marker")).rejects.toThrow("not running");
});
