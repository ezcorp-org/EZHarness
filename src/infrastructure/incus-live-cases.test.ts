import { expect, test } from "bun:test";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { GUEST_HELPER_SHA256 } from "./incus-guest/protocol";
import {
  beginDurableIncusLiveCases,
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
    .rejects.toThrow("preparation deadline expired");
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
