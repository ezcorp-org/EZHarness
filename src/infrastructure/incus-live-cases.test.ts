import { createHash } from "node:crypto";
import { IncusLiveWitnessError } from "./incus-host-live-witness";
import { IncusLimitLoadFailure, IncusCpuLoadProofError } from "./incus-live-limit-probe";
import { expect, test } from "bun:test";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { IncusQualificationOperationUnsettledError } from "./incus-qualification";
import { GUEST_HELPER_SHA256 } from "./incus-guest/protocol";
import {
  beginDurableIncusLiveCases,
  incusPreparationCauseCode,
  incusGuestFailureCauseCode,
  INCUS_WITNESS_GUEST_OPERATIONS,
  INCUS_PREPARATION_CAUSE_CODES,
  createIncusLiveCaseRunner,
  resumeDurableIncusLiveCases,
  type DurableIncusLiveWitness,
  type HostIncusLiveWitness,
  type LiveCleanupRecoveryFact,
  type LiveLimitLoadFact,
} from "./incus-live-cases";

const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "incus-linux-exec-v1" };
const preset = { ...INCUS_PRESETS[0]!, imageDigest: "a".repeat(64) };
const observation = { backendApi: "incus.v1", backendVersion: "6.0.6", architecture: "amd64" as const,
  storageDriver: "btrfs", isolation: "container" as const, nestedCompose: false };

function witness(overrides: Partial<HostIncusLiveWitness> = {}) {
  const states = new Map<string, "stopped" | "running" | "absent">();
  const files = new Map<string, Uint8Array>();
  const destroyed: string[] = [];
  const loadFacts: LiveLimitLoadFact[] = [
    ["memory", preset.limits.memoryBytes], ["cpu", preset.limits.cpuMillis],
    ["pids", preset.limits.pids], ["disk", preset.limits.diskBytes],
  ].map(([resource, bound]) => ({ resource: resource as LiveLimitLoadFact["resource"],
    attempted: Number(bound) + 1, observedLimit: Number(bound), contained: true,
    neighborHealthy: true, hostHealthy: true }));
  const recovery: LiveCleanupRecoveryFact = { firstDestroyOperationId: "destroy-op", recordedState: "RECONCILE_REQUIRED",
    readinessErrorCode: "QUALIFICATION_CLEANUP_UNVERIFIED", reconciledOperationId: "destroy-op",
    finalState: "absent", unrelatedState: "stopped" };
  const base: HostIncusLiveWitness = {
    preflightNetwork: async () => {},
    observe: async () => ({ observation, profile: preset.profile, imageDigest: preset.imageDigest,
      helperDigest: GUEST_HELPER_SHA256 }),
    controlFacts: async () => ({ baselinePlanDigest: "b".repeat(64), repeatedPlanDigest: "b".repeat(64),
      changedPlanDigest: "c".repeat(64), unsupportedAdmissionCode: "DENIED_UNSUPPORTED",
      unsupportedAllocationDelta: 0, missingControlAdmissionCode: "DENIED_CONTROL", missingControlAllocationDelta: 0,
      driftAdmissionCode: "DENIED_DRIFT", driftAllocationDelta: 0,
      unqualifiedAdmissionCode: "DENIED_UNQUALIFIED", unqualifiedAllocationDelta: 0,
      localCanaryBefore: "d".repeat(64), localCanaryAfter: "d".repeat(64) }),
    createFixture: async (_scope, _preset, operationId) => {
      const sandboxId = `sandbox-${operationId}`;
      if (!states.has(sandboxId)) states.set(sandboxId, "stopped");
      return { sandboxId, operationId };
    },
    inspectFixture: async handle => ({ sandboxId: handle.sandboxId, state: states.get(handle.sandboxId) ?? "absent",
      imageDigest: preset.imageDigest, helperDigest: GUEST_HELPER_SHA256, profile: preset.profile,
      workspaceRoot: "/workspace", guestUser: "sandbox", memoryBytes: preset.limits.memoryBytes,
      cpuMillis: preset.limits.cpuMillis, pids: preset.limits.pids, diskBytes: preset.limits.diskBytes,
      storageDriver: "btrfs", privateNetwork: true, restrictedProject: true, unprivileged: true,
      bootId: states.get(handle.sandboxId) === "running" ? "boot-id" : null }),
    observeEnforcement: async () => ({ memoryMaxBytes: preset.limits.memoryBytes,
      cpuQuotaMillis: preset.limits.cpuMillis, pidsMax: preset.limits.pids,
      rootQuotaBytes: preset.limits.diskBytes, privateNetworkProbeBlocked: true, unprivilegedUidMap: true }),
    exerciseLimits: async () => loadFacts,
    setPower: async (handle, state) => { states.set(handle.sandboxId, state); },
    run: async (_handle, argv) => ({ exitCode: 0, stdout: String(argv.at(-1)), stderr: "" }),
    writeFile: async (handle, path, bytes) => { files.set(`${handle.sandboxId}/${path}`, bytes); },
    readFile: async (handle, path) => files.get(`${handle.sandboxId}/${path}`) ?? new Uint8Array(),
    restartController: async () => ({ beforeProcessId: "engine-1", afterProcessId: "engine-2" }),
    exerciseFailedCleanupRecovery: async handle => { states.set(handle.sandboxId, "absent"); return recovery; },
    destroyFixture: async handle => { destroyed.push(handle.sandboxId); states.set(handle.sandboxId, "absent"); },
  };
  return { value: { ...base, ...overrides } satisfies HostIncusLiveWitness, destroyed, states, loadFacts, recovery };
}

test("no host authority or published image cannot produce live cases", async () => {
  expect(() => createIncusLiveCaseRunner({ witness: undefined as unknown as HostIncusLiveWitness })).toThrow("authority");
  const value = witness();
  const unbuilt = { ...preset, imageDigest: "0".repeat(64) };
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, unbuilt)).rejects.toThrow("preset or helper");
  expect(value.states.size).toBe(0);
});

test("a controlled load gap prevents SP04 and still cleans up the fixture", async () => {
  const value = witness({ exerciseLimits: async () => [witness().loadFacts[0]!] });
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, preset)).rejects.toThrow("controlled limit loads");
  expect(value.destroyed).toHaveLength(2);
});

test("a failed replay after the first create cleans the primary fixture", async () => {
  const value = witness();
  let creates = 0;
  const originalCreate = value.value.createFixture;
  value.value.createFixture = async (...args) => {
    if (++creates === 2) throw new Error("lost reply replay failed");
    return originalCreate(...args);
  };
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, preset))
    .rejects.toThrow("lost reply replay failed");
  expect(value.destroyed).toHaveLength(1);
});

test("missing Compose artifact cannot be called a real Compose pass", async () => {
  const value = witness({ observe: async () => ({ observation: { ...observation, nestedCompose: true },
    profile: preset.profile, imageDigest: preset.imageDigest, helperDigest: GUEST_HELPER_SHA256 }) });
  const compose = { ...preset, requirements: { ...preset.requirements, nestedCompose: true } };
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, compose)).rejects.toThrow("Compose fixture image");
  expect(value.destroyed).toHaveLength(2);
  const moving = witness({ observe: value.value.observe });
  await expect(createIncusLiveCaseRunner({ witness: moving.value,
    composeFixtureImageRef: "docker.io/library/busybox:latest" })(scope, compose)).rejects.toThrow("Compose fixture image");
  expect(moving.destroyed).toHaveLength(2);
});

test("host or neighbor impact prevents SP04", async () => {
  const facts = witness().loadFacts.map(item => ({ ...item }));
  facts[0]!.neighborHealthy = false;
  const value = witness({ exerciseLimits: async () => facts });
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, preset)).rejects.toThrow("affected a neighbor");
  expect(value.destroyed).toHaveLength(2);
});

test("isolation and load probes receive a distinct running neighbor", async () => {
  const value = witness();
  const calls: string[] = [];
  value.value.observeEnforcement = async (primary, unrelated) => {
    expect(primary.sandboxId).not.toBe(unrelated.sandboxId);
    expect(value.states.get(primary.sandboxId)).toBe("running");
    expect(value.states.get(unrelated.sandboxId)).toBe("running");
    calls.push("enforcement");
    return witness().value.observeEnforcement(primary, unrelated);
  };
  value.value.exerciseLimits = async (primary, unrelated) => {
    expect(primary.sandboxId).not.toBe(unrelated.sandboxId);
    expect(value.states.get(unrelated.sandboxId)).toBe("running");
    calls.push("load");
    return value.loadFacts;
  };
  await createIncusLiveCaseRunner({ witness: value.value })(scope, preset);
  expect(calls).toEqual(["enforcement", "load"]);
  expect([...value.states.values()]).toEqual(["absent", "absent", "absent"]);
});

test("failed cleanup recovery or cleanup itself denies SP06", async () => {
  const incomplete = witness({ exerciseFailedCleanupRecovery: async () => ({ ...witness().recovery,
    finalState: "stopped" }) });
  await expect(createIncusLiveCaseRunner({ witness: incomplete.value })(scope, preset)).rejects.toThrow("failed cleanup");
  const cleanupFailure = witness({ destroyFixture: async () => { throw new Error("Incus destroy unavailable"); } });
  await expect(createIncusLiveCaseRunner({ witness: cleanupFailure.value })(scope, preset)).rejects.toThrow("cleanup is unverified");
});

test("the runner emits cases only after ordered host observations and cleanup", async () => {
  const value = witness();
  const result = await createIncusLiveCaseRunner({ witness: value.value, now: () => Date.parse("2026-09-22T12:00:00Z") })(scope, preset);
  expect(result.cases.map(item => item.caseId)).toEqual(["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08"]);
  expect(result.cases.every(item => item.status === "passed")).toBe(true);
  expect(value.destroyed).toHaveLength(2);
});

test("Compose needs a real HTTP and WebSocket preview witness before SP09", async () => {
  const compose = { ...INCUS_PRESETS[1]!, imageDigest: preset.imageDigest };
  const composeScope = { ...scope, presetId: compose.id };
  const composeWitness = () => {
    const result = witness({ observe: async () => ({ observation: { ...observation, nestedCompose: true },
      profile: compose.profile, imageDigest: compose.imageDigest, helperDigest: GUEST_HELPER_SHA256 }),
      run: async (_handle, argv) => ({ exitCode: 0,
        stdout: argv[0] === "docker" ? "ezh-compose-ok" : String(argv.at(-1)), stderr: "" }),
    });
    const inspect = result.value.inspectFixture;
    result.value.inspectFixture = async handle => ({ ...await inspect(handle), profile: compose.profile });
    return result;
  };
  const absent = composeWitness();
  const image = `docker.io/library/busybox@sha256:${"a".repeat(64)}`;
  await expect(createIncusLiveCaseRunner({ witness: absent.value, composeFixtureImageRef: image })
    (composeScope, compose)).rejects.toThrow("preview witness is unavailable");
  expect(absent.destroyed).toHaveLength(2);

  const facts = composeWitness();
  let seenRunning = false;
  facts.value.exercisePreviewAndStop = async (handle, selectedScope, selectedPreset, challenge) => {
    seenRunning = facts.states.get(handle.sandboxId) === "running"
      && selectedScope.presetId === compose.id && selectedPreset.id === compose.id;
    facts.states.set(handle.sandboxId, "stopped");
    const hash = createHash("sha256").update(challenge).digest("hex");
    return { version: 1, connectionId: selectedScope.connectionId, presetId: compose.id,
      releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64), imageDigest: compose.imageDigest,
      helperDigest: GUEST_HELPER_SHA256, sandboxId: handle.sandboxId,
      operationId: handle.operationId, generation: 1, endpointId: "endpoint-1", ownerId: "owner-1",
      port: 4173, expiresAt: new Date(Date.now() + 30_000).toISOString(), challengeSha256: hash,
      httpStatus: 200, httpBodySha256: hash, webSocketStatus: 101,
      webSocketMessageSha256: hash, webSocketSubprotocol: "vite-hmr",
      relay: { destination: "pinned-guest-loopback", instanceId: handle.sandboxId, port: 4173,
        httpRequests: 1, webSocketConnections: 1, hostConnectAttempts: 0, managementConnectAttempts: 0 },
      denied: { missingAuth: 404, wrongOwner: 404, wrongSandbox: 502, wrongGeneration: 502,
        wrongPort: 502, expired: 404, malformed: 404, revoked: 404, stopped: 502,
        hostLoopback: 502, management: 502, webSocketWrongOwner: 403 },
    };
  };
  const result = await createIncusLiveCaseRunner({ witness: facts.value, composeFixtureImageRef: image })
    (composeScope, compose);
  expect(seenRunning).toBe(true);
  expect(result.cases.at(-1)?.caseId).toBe("SP09");
  expect(result.previewProof?.httpBodySha256).toBe(result.previewProof?.challengeSha256);
  expect(facts.destroyed).toHaveLength(2);
});

test("persistent workspace bytes must survive the controller restart", async () => {
  const value = witness({ readFile: async () => new TextEncoder().encode("wrong retained marker") });
  const persistent = { ...preset, storage: { ...preset.storage, workspace: "persistent" as const } };
  await expect(createIncusLiveCaseRunner({ witness: value.value })(scope, persistent))
    .rejects.toThrow("retained workspace changed after restart");
  expect(value.destroyed).toHaveLength(2);
});

test("the restart authority receives the exact stopped fixture", async () => {
  const value = witness();
  const restarted: Array<{ sandboxId: string; operationId: string }> = [];
  value.value.restartController = async handle => {
    expect(value.states.get(handle.sandboxId)).toBe("stopped");
    restarted.push(handle);
    return { beforeProcessId: "engine-1", afterProcessId: "engine-2" };
  };
  await createIncusLiveCaseRunner({ witness: value.value })(scope, preset);
  expect(restarted).toEqual([{ sandboxId: expect.stringMatching(/^sandbox-qual-primary-/),
    operationId: expect.stringMatching(/^qual-primary-/) }]);
});

test("a replacement runner claims the saved primary and completes cleanup before evidence", async () => {
  const original = witness();
  const run = { runId: "durable-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 };
  let saved: { handle: { sandboxId: string; operationId: string }; runId: string; nonce: string } | undefined;
  const first: DurableIncusLiveWitness = {
    ...original.value,
    findFixture: async () => { throw new Error("the first process cannot resume"); },
    beginRestart: async (_scope, _preset, handle, runId, nonce) => {
      expect(original.states.get(handle.sandboxId)).toBe("stopped");
      saved = { handle, runId, nonce };
    },
    claimRestart: async () => { throw new Error("the first process cannot claim"); },
  };
  expect(await beginDurableIncusLiveCases({ witness: first }, scope, preset, run))
    .toEqual({ runId: run.runId, state: "AWAITING_RESTART" });
  expect(original.destroyed).toEqual([]);
  const replacement: DurableIncusLiveWitness = {
    ...original.value,
    findFixture: async (_scope, operationId) => ({ operationId, sandboxId: `sandbox-${operationId}` }),
    beginRestart: async () => { throw new Error("replacement cannot begin again"); },
    claimRestart: async (_scope, _preset, runId, nonce) => {
      expect(runId).toBe(saved!.runId);
      expect(nonce).toBe(saved!.nonce);
      return saved!.handle;
    },
  };
  const evidence = await resumeDurableIncusLiveCases({ witness: replacement }, scope, preset, run);
  expect(evidence.cases).toHaveLength(8);
  expect(original.destroyed).toHaveLength(2);
  expect([...original.states.values()]).toEqual(["absent", "absent", "absent"]);
});

test("slow controlled loads get a fresh short restart handoff, while preparation stays bounded", async () => {
  let clock = Date.now();
  const initial = clock;
  const original = witness({ exerciseLimits: async () => {
    clock += 8 * 60_000;
    return witness().loadFacts;
  } });
  let handoffDeadline = 0;
  const first: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("not resumed"); },
    claimRestart: async () => { throw new Error("not resumed"); },
    beginRestart: async (_scope, _preset, _handle, _runId, _nonce, deadlineMs) => {
      handoffDeadline = deadlineMs;
    } };
  await beginDurableIncusLiveCases({ witness: first, now: () => clock }, scope, preset,
    { runId: "slow-run", nonce: "fresh-nonce", deadlineMs: initial + 20 * 60_000 });
  expect(handoffDeadline).toBe(clock + 110_000);
  expect(handoffDeadline).toBeGreaterThan(initial + 110_000);

  const expired = witness({ exerciseLimits: async () => {
    clock += 21 * 60_000;
    return witness().loadFacts;
  } });
  const denied: DurableIncusLiveWitness = { ...expired.value,
    findFixture: async () => { throw new Error("not resumed"); },
    claimRestart: async () => { throw new Error("not resumed"); },
    beginRestart: async () => { throw new Error("expired run must not restart"); } };
  await expect(beginDurableIncusLiveCases({ witness: denied, now: () => clock }, scope, preset,
    { runId: "expired-run", nonce: "fresh-nonce", deadlineMs: clock + 20 * 60_000 }))
    .rejects.toMatchObject({ stage: "limit_loads", cleanup: "confirmed" });
  expect(expired.destroyed).toHaveLength(2);
});

test("an unclaimed or changed durable run cannot publish cases", async () => {
  const original = witness();
  const replacement: DurableIncusLiveWitness = {
    ...original.value,
    findFixture: async () => { throw new Error("must not read fixtures"); },
    beginRestart: async () => { throw new Error("must not begin"); },
    claimRestart: async () => { throw new Error("operator receipt is unavailable"); },
  };
  await expect(resumeDurableIncusLiveCases({ witness: replacement }, scope, preset,
    { runId: "unknown", nonce: "unknown" })).rejects.toThrow("operator receipt is unavailable");
  expect(original.states.size).toBe(0);
  replacement.claimRestart = async () => ({ operationId: "wrong-primary", sandboxId: "wrong-binding" });
  await expect(resumeDurableIncusLiveCases({ witness: replacement }, scope, preset,
    { runId: "unknown", nonce: "unknown" })).rejects.toThrow("claimed primary fixture changed");
});

test("a failed replacement observation cleans both claimed fixtures before returning the error", async () => {
  const original = witness();
  const run = { runId: "failed-resume", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 };
  const first: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("first process cannot resume"); },
    claimRestart: async () => { throw new Error("first process cannot claim"); },
    beginRestart: async () => {},
  };
  await beginDurableIncusLiveCases({ witness: first }, scope, preset, run);
  const replacement: DurableIncusLiveWitness = { ...original.value,
    findFixture: async (_scope, operationId) => ({ operationId, sandboxId: `sandbox-${operationId}` }),
    claimRestart: async () => ({ operationId: `qual-primary-${run.runId}`,
      sandboxId: `sandbox-qual-primary-${run.runId}` }),
    beginRestart: async () => { throw new Error("replacement cannot restart again"); },
    observe: async () => { throw new Error("host observation failed after restart"); },
  };
  await expect(resumeDurableIncusLiveCases({ witness: replacement }, scope, preset, run))
    .rejects.toThrow("host observation failed after restart");
  expect(original.destroyed).toHaveLength(2);
  expect([...original.states.values()]).toEqual(["absent", "absent"]);
});


test("unsettled saved fixture operations preserve admitted work in every runner", async () => {
  const pending = new IncusQualificationOperationUnsettledError("saved-operation", "OUTCOME_UNKNOWN");
  const original = witness({ setPower: async () => { throw pending; } });
  await expect(createIncusLiveCaseRunner({ witness: original.value })(scope, preset)).rejects.toBe(pending);
  expect(original.destroyed).toEqual([]);
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async (_scope, operationId) => ({ operationId, sandboxId: `sandbox-${operationId}` }),
    beginRestart: async () => { throw new Error("unexpected restart"); },
    claimRestart: async () => ({ operationId: "qual-primary-pending-run", sandboxId: "sandbox-qual-primary-pending-run" }),
  };
  const run = { runId: "pending-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 };
  await expect(beginDurableIncusLiveCases({ witness: durable }, scope, preset, run)).rejects.toBe(pending);
  expect(original.destroyed).toEqual([]);
  original.states.set("sandbox-qual-primary-pending-run", "stopped");
  original.states.set("sandbox-qual-unrelated-pending-run", "stopped");
  const resumed: DurableIncusLiveWitness = { ...durable, observe: async () => { throw pending; } };
  await expect(resumeDurableIncusLiveCases({ witness: resumed }, scope, preset, run)).rejects.toBe(pending);
  expect(original.destroyed).toEqual([]);
});

test("durable preparation reports a safe enforcement stage and preserves cleanup", async () => {
  const original = witness({ observeEnforcement: async () => { throw new Error("Incus live network probe unavailable: neighbor listener ended before it was ready"); } });
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async (_scope, operationId) => ({ operationId, sandboxId: `sandbox-${operationId}` }),
    beginRestart: async () => { throw new Error("unexpected handoff"); },
    claimRestart: async () => { throw new Error("unexpected claim"); },
  };
  let failure: unknown;
  try { await beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "diagnostic-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ stage: "enforcement", cleanup: "confirmed", causeCode: "neighbor_listener_ended_before_it_was_ready" });
  expect(JSON.stringify(failure)).not.toContain("secret");
  expect(original.destroyed).toHaveLength(2);
});


test("preparation diagnostic distinguishes failed cleanup without exposing provider errors", async () => {
  const original = witness({ exerciseLimits: async () => { throw new Error("provider secret"); },
    destroyFixture: async () => { throw new Error("cleanup secret"); } });
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("unexpected lookup"); },
    beginRestart: async () => { throw new Error("unexpected restart"); },
    claimRestart: async () => { throw new Error("unexpected claim"); } };
  await expect(beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "failed-cleanup-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }))
    .rejects.toMatchObject({ stage: "limit_loads", cleanup: "unverified" });
});


test("preparation cause classification accepts only literal assertions and known typed codes", () => {
  expect(incusPreparationCauseCode(new Error("Incus resource probe unavailable: guest reached a forbidden network target"))).toBe("guest_reached_a_forbidden_network_target");
  expect(incusPreparationCauseCode(Object.assign(new Error("private credential"), { code: "PERMISSION_DENIED" }))).toBe("PERMISSION_DENIED");
  for (const value of [null, "secret", new Error("private credential"), new Error("Incus resource probe unavailable: private credential"), Object.assign(new Error("secret"), { code: "secret-code" })]) {
    expect(incusPreparationCauseCode(value)).toBe("unclassified");
  }
  expect(INCUS_PREPARATION_CAUSE_CODES.has("secret-code")).toBe(false);
});

test("missing reviewed neighbor control fails before any fixture allocation", async () => {
  let allocations = 0;
  const original = witness({ createFixture: async () => {
    allocations++;
    throw new Error("fixture allocation must not run");
  } });
  const durable: DurableIncusLiveWitness = {
    ...original.value,
    findFixture: async () => { throw new Error("fixture lookup must not run"); },
    preflightNetwork: async () => { throw new Error("Incus live network probe unavailable: reviewed neighbor control transport is unavailable"); },
    beginRestart: async () => { throw new Error("restart must not run"); },
    claimRestart: async () => { throw new Error("restart must not run"); },
  };
  await expect(beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "missing-control-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }))
    .rejects.toMatchObject({ stage: "fixtures", cleanup: "confirmed",
      causeCode: "reviewed_neighbor_control_transport_is_unavailable" });
  expect(allocations).toBe(0);
});

test("durable CPU proof failure preserves bounded numeric evidence through cleanup", async () => {
  const cpuLoad = { throttledDelta: 0, elapsedMs: 4000, quotaMicros: 200000, periodMicros: 100000,
    cpusetCount: 32, affinityCount: 32, outsideCpuCount: 0, workerCount: 3, workerFailures: 0, workerCpuUsec: 7_000_000,
    usageDeltaUsec: 7_100_000, controlsUnchanged: true, affinityConfined: true };
  const original = witness({ exerciseLimits: async () => { throw new IncusCpuLoadProofError(cpuLoad); } });
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("unexpected lookup"); },
    beginRestart: async () => { throw new Error("unexpected restart"); },
    claimRestart: async () => { throw new Error("unexpected claim"); } };
  await expect(beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "cpu-diagnostic-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }))
    .rejects.toMatchObject({ stage: "limit_loads", cleanup: "confirmed", causeCode: "cpu_load_did_not_prove_containment", cpuLoad });
  expect(original.destroyed).toHaveLength(2);
});


test("guest diagnostic accepts finite method/code pairs and omits unknown private values", () => {
  for (const operation of INCUS_WITNESS_GUEST_OPERATIONS) {
    for (const code of ["INVALID_ARGUMENT", "NOT_FOUND", "ALREADY_EXISTS", "REVISION_CONFLICT",
      "UNSUPPORTED_CAPABILITY", "DEADLINE_EXCEEDED", "UNAVAILABLE", "PERMISSION_DENIED",
      "RESOURCE_EXHAUSTED", "OUTCOME_UNKNOWN", "INTERNAL"]) {
      const expected = `guest_${operation.replace(".", "_")}_${code.toLowerCase()}`;
      expect(incusGuestFailureCauseCode(operation, code)).toBe(expected);
      expect(INCUS_PREPARATION_CAUSE_CODES.has(expected)).toBe(true);
      expect(incusPreparationCauseCode(new IncusLiveWitnessError("guest action failed", operation, code))).toBe(expected);
    }
  }
  for (const [operation, code] of [["private-method", "UNAVAILABLE"], ["processes.start", "private-code"],
    [null, "UNAVAILABLE"], ["processes.start", { secret: "private" }]]) {
    const failure = new IncusLiveWitnessError("guest action failed", operation, code);
    expect(failure.code).toBe("guest_action_failed");
    expect(incusPreparationCauseCode(failure)).toBe("guest_action_failed");
    expect(JSON.stringify(failure)).not.toContain("private");
  }
});

test("running primary guest failure retains safe method/code and confirmed cleanup", async () => {
  const original = witness();
  const inspect = original.value.inspectFixture;
  original.value.inspectFixture = async handle => {
    if (original.states.get(handle.sandboxId) === "running") {
      throw new IncusLiveWitnessError("guest action failed", "processes.start", "OUTCOME_UNKNOWN");
    }
    return inspect(handle);
  };
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("unexpected lookup"); },
    beginRestart: async () => { throw new Error("unexpected restart"); },
    claimRestart: async () => { throw new Error("unexpected claim"); } };
  let failure: unknown;
  try { await beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "guest-diagnostic-run", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }); }
  catch (error) { failure = error; }
  expect(failure).toMatchObject({ message: "Incus qualification preparation failed", stage: "fixtures",
    cleanup: "confirmed", causeCode: "guest_processes_start_outcome_unknown" });
  expect(original.destroyed).toHaveLength(1);
});

test("load failure keeps the exact public guest code and resource while omitting its private cause", async () => {
  for (const resource of ["memory", "cpu", "pids", "disk"] as const) {
    const cause = new IncusLiveWitnessError("secret-canary stderr credentials", "processes.readOutput", "DEADLINE_EXCEEDED");
    const original = witness({ exerciseLimits: async () => { throw new IncusLimitLoadFailure(resource, cause); } });
    const durable: DurableIncusLiveWitness = { ...original.value,
      findFixture: async () => { throw new Error("unexpected lookup"); },
      beginRestart: async () => { throw new Error("unexpected restart"); },
      claimRestart: async () => { throw new Error("unexpected claim"); } };
    let failure: unknown;
    try { await beginDurableIncusLiveCases({ witness: durable }, scope, preset,
      { runId: `load-diagnostic-${resource}`, nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ stage: "limit_loads", cleanup: "confirmed",
      causeCode: "guest_processes_readOutput_deadline_exceeded", limitResource: resource });
    expect(JSON.stringify(failure)).not.toContain("secret-canary");
    expect(original.destroyed).toHaveLength(2);
  }
  expect(incusPreparationCauseCode(Object.assign(new Error("secret-canary"), { resource: "memory", cause: new IncusLiveWitnessError("private", "processes.readOutput", "DEADLINE_EXCEEDED") }))).toBe("unclassified");
});

test("resource tagging cannot hide an unsettled operation or dispatch cleanup for it", async () => {
  const preserved = new IncusQualificationOperationUnsettledError("preserved-operation", "OUTCOME_UNKNOWN", new Error("private-canary"));
  const original = witness({ exerciseLimits: async () => { throw new IncusLimitLoadFailure("memory", preserved); } });
  const durable: DurableIncusLiveWitness = { ...original.value,
    findFixture: async () => { throw new Error("unexpected lookup"); },
    beginRestart: async () => { throw new Error("unexpected restart"); },
    claimRestart: async () => { throw new Error("unexpected claim"); } };
  let failure: unknown;
  try { await beginDurableIncusLiveCases({ witness: durable }, scope, preset,
    { runId: "load-preserved", nonce: "fresh-nonce", deadlineMs: Date.now() + 60_000 }); }
  catch (error) { failure = error; }
  expect(failure).toBe(preserved);
  expect(original.destroyed).toEqual([]);
});

test("nondurable runner also preserves a resource-wrapped unknown without cleanup", async () => {
  const preserved = new IncusQualificationOperationUnsettledError("preserved-operation", "OUTCOME_UNKNOWN", new Error("private-canary"));
  const original = witness({ exerciseLimits: async () => { throw new IncusLimitLoadFailure("memory", preserved); } });
  let failure: unknown;
  try { await createIncusLiveCaseRunner({ witness: original.value })(scope, preset); }
  catch (error) { failure = error; }
  expect(failure).toBe(preserved);
  expect(original.destroyed).toEqual([]);
});
