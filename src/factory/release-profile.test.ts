import { expect, test } from "bun:test";
import {
  assertFactoryReleaseProfileResult,
  FACTORY_RELEASE_RESOLVE_TIMEOUT_MS,
  FactoryReleaseProfileError,
  factoryReleaseProfileInputDigest,
  resolveFactoryReleaseProfile,
  sealFactoryReleaseProfileResult,
  type FactoryAsyncReleaseProfile,
  type FactoryReleaseProfileInput,
  type FactoryReleaseProfileResult,
} from "./release-profile";
import { factorySynchronousReleaseProfile } from "./protected-command-effects";
import type { RunnerReference } from "@ezcorp/factory-sdk";

const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
const adapter: RunnerReference = { package: "@ezcorp/release", version: "1.0.0", digest: digest("a"), export: "publish", configurationDigest: digest("b") };
const RESOLVED_AT = 1_700_000_000_000;

function input(overrides: Partial<FactoryReleaseProfileInput> = {}): FactoryReleaseProfileInput {
  return {
    tenantId: "tenant-1",
    projectId: "project-1",
    runId: "run-1",
    acceptedManifest: { candidate: "bytes" },
    requestedDestination: { provider: "github", repository: "ezcorp/demo" },
    decision: { projectId: "project-1", runId: "run-1", nodeInstanceId: "release", candidateGeneration: 0, decisionId: "decision-1", candidateDigest: digest("c"), evidenceSetDigest: digest("d"), contractDigest: digest("e"), contractSnapshotDigest: digest("f"), executionEpoch: 1, cancellationEpoch: 0 },
    material: { decisionId: "decision-1", evidence: [], packageTrustDigest: digest("1"), validatorTrustDigest: digest("2") },
    ...overrides,
  };
}

const built = { destination: { provider: "github", account: "ezcorp", object: "demo" }, request: { title: "release" }, estimatedSpendMicros: 42 } as const;

function sealed(overrides: Partial<FactoryReleaseProfileResult> = {}, source = input()): FactoryReleaseProfileResult {
  const base = sealFactoryReleaseProfileResult(source, built, RESOLVED_AT);
  if (Object.keys(overrides).length === 0) return base;
  const { resultDigest: _resultDigest, ...body } = { ...base, ...overrides };
  return { ...body, resultDigest: overrides.resultDigest ?? base.resultDigest } as FactoryReleaseProfileResult;
}

function profile(resolve: FactoryAsyncReleaseProfile["resolve"]): FactoryAsyncReleaseProfile {
  return { adapter, action: "publish", resolve };
}

const code = async (act: () => unknown): Promise<string | undefined> => {
  try { await act(); return undefined; }
  catch (error) { return error instanceof FactoryReleaseProfileError ? error.code : `unexpected:${String(error)}`; }
};

test("a sealed result binds the exact input it was resolved from", () => {
  const result = sealed();
  expect(result.inputDigest).toBe(factoryReleaseProfileInputDigest(input()));
  expect(result.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(assertFactoryReleaseProfileResult(result, result.inputDigest, RESOLVED_AT)).toEqual(result);
  expect(sealed().resultDigest).toBe(result.resultDigest);
  expect(factoryReleaseProfileInputDigest(input({ acceptedManifest: { candidate: "other" } }))).not.toBe(result.inputDigest);
  expect(sealFactoryReleaseProfileResult(input(), { ...built, estimatedSpendMicros: 43 }, RESOLVED_AT).resultDigest).not.toBe(result.resultDigest);
});

test("a result that no longer matches its input, or that has aged out, is stale", async () => {
  const result = sealed();
  expect(await code(() => assertFactoryReleaseProfileResult(result, digest("9"), RESOLVED_AT))).toBe("factory_release_profile_stale");
  expect(await code(() => assertFactoryReleaseProfileResult(result, result.inputDigest, RESOLVED_AT + FACTORY_RELEASE_RESOLVE_TIMEOUT_MS + 1))).toBe("factory_release_profile_stale");
  expect(assertFactoryReleaseProfileResult(result, result.inputDigest, RESOLVED_AT + FACTORY_RELEASE_RESOLVE_TIMEOUT_MS)).toEqual(result);
  expect(await code(() => assertFactoryReleaseProfileResult(result, result.inputDigest, RESOLVED_AT - 1))).toBe("factory_release_profile_stale");
});

test("a malformed, over-sized, or unsealed result is rejected before it can reach a destination", async () => {
  const result = sealed();
  for (const value of [
    { ...result, schemaVersion: "factory.release-profile-result.v2" },
    { ...result, estimatedSpendMicros: -1 },
    { ...result, estimatedSpendMicros: 1.5 },
    { ...result, resolvedAtMs: 0 },
    { ...result, inputDigest: "not-a-digest" },
    { ...result, resultDigest: "not-a-digest" },
    { ...result, resultDigest: digest("0") },
    { ...result, destination: null },
    { ...result, destination: [] },
    { ...result, destination: { ...built.destination, provider: "" } },
    { ...result, destination: { ...built.destination, object: "o".repeat(513) } },
    { ...result, destination: { ...built.destination, expectedVersion: "" } },
    { ...result, request: { padding: "x".repeat(1024 * 1024) } },
    { ...result, extra: 1 },
  ] as unknown as FactoryReleaseProfileResult[]) {
    expect(await code(() => assertFactoryReleaseProfileResult(value, result.inputDigest, RESOLVED_AT))).toBe("factory_release_profile_invalid");
  }
  expect(await code(() => assertFactoryReleaseProfileResult(result, result.inputDigest, 1.5))).toBe("factory_release_profile_invalid");
  const versioned = sealFactoryReleaseProfileResult(input(), { ...built, destination: { ...built.destination, expectedVersion: "v1" } }, RESOLVED_AT);
  expect(assertFactoryReleaseProfileResult(versioned, versioned.inputDigest, RESOLVED_AT)).toEqual(versioned);
});

test("resolve runs under the caller's signal and refuses a result that arrives after an abort", async () => {
  const controller = new AbortController();
  const good = profile(async (value, signal) => { expect(signal.aborted).toBe(false); return sealFactoryReleaseProfileResult(value, built, RESOLVED_AT); });
  expect(await resolveFactoryReleaseProfile(good, input(), controller.signal, () => RESOLVED_AT)).toEqual(sealed());

  const aborted = new AbortController();
  aborted.abort();
  expect(await code(() => resolveFactoryReleaseProfile(good, input(), aborted.signal, () => RESOLVED_AT))).toBe("factory_release_profile_aborted");

  const slow = new AbortController();
  let release: (result: FactoryReleaseProfileResult) => void = () => {};
  const pending = profile(() => new Promise<FactoryReleaseProfileResult>(resolvePromise => { release = resolvePromise; }));
  const running = resolveFactoryReleaseProfile(pending, input(), slow.signal, () => RESOLVED_AT);
  slow.abort();
  expect(await code(() => running)).toBe("factory_release_profile_aborted");
  release(sealed());

  // A profile that keeps working through its own abort cannot have its result used.
  const lateController = new AbortController();
  const late = profile(async (value) => { lateController.abort(); return sealFactoryReleaseProfileResult(value, built, RESOLVED_AT); });
  expect(await code(() => resolveFactoryReleaseProfile(late, input(), lateController.signal, () => RESOLVED_AT))).toBe("factory_release_profile_aborted");
});

test("a resolved result is validated, so a profile cannot return a foreign seal", async () => {
  const foreign = profile(async () => sealFactoryReleaseProfileResult(input({ runId: "run-2" }), built, RESOLVED_AT));
  expect(await code(() => resolveFactoryReleaseProfile(foreign, input(), new AbortController().signal, () => RESOLVED_AT))).toBe("factory_release_profile_stale");
  const forged = profile(async () => ({ ...sealed(), estimatedSpendMicros: 99 }));
  expect(await code(() => resolveFactoryReleaseProfile(forged, input(), new AbortController().signal, () => RESOLVED_AT))).toBe("factory_release_profile_invalid");
});

test("a synchronous build satisfies the asynchronous surface without a second bridge", async () => {
  const lifted = factorySynchronousReleaseProfile({ adapter, action: "publish", build: (value) => ({ destination: built.destination, request: { title: "release", candidate: value.acceptedCandidate }, estimatedSpendMicros: 7 }) }, () => RESOLVED_AT);
  expect(lifted.action).toBe("publish");
  expect(lifted.build({ acceptedCandidate: { candidate: "bytes" }, destination: {}, decision: input().decision, material: input().material }).estimatedSpendMicros).toBe(7);
  const resolved = await resolveFactoryReleaseProfile(lifted, input(), new AbortController().signal, () => RESOLVED_AT);
  expect(resolved).toMatchObject({ estimatedSpendMicros: 7, request: { title: "release", candidate: { candidate: "bytes" } } });
  const aborted = new AbortController();
  aborted.abort();
  expect(await code(() => lifted.resolve(input(), aborted.signal))).toBe("factory_release_profile_aborted");
});
