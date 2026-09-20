import { expect, test } from "bun:test";
import type { FactoryGuestModelRequest, FactoryMeasuredUsage, FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { createFactoryGuestModelBroker, isFactoryGuestModelPayload, type FactoryGuestModelJournal, type FactoryModelCompletion } from "./guest-model-broker";
import { createFactoryMemoryGuestModelJournal } from "./guest-model-journal";
import { factoryLaunchRequest } from "../../__tests__/helpers/factory-attempt-launch-fixture";

const digest = `sha256:${"a".repeat(64)}`;
const pin: FactoryModelPin = { provider: "anthropic", model: "claude-opus-5", configurationDigest: digest, configuration: {}, policyDigest: digest, policy: {} };
const usage: FactoryMeasuredUsage = { kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 21, costMicros: "1200" };
const completion: FactoryModelCompletion = { text: "the whole answer", providerReceiptDigest: "b".repeat(64), usage };

// `null` means an attempt with no pin at all. An optional parameter cannot say
// that: `attempt(undefined)` takes the default and silently yields a PINNED
// attempt, which is how the unpinned case first passed against the wrong input.
function attempt(model: FactoryModelPin | null = pin): FactoryRunnerRequest {
  return { ...factoryLaunchRequest({ attemptId: "attempt-broker" }), ...(model ? { model } : {}) } as FactoryRunnerRequest;
}

function request(overrides: Partial<FactoryGuestModelRequest> = {}): FactoryGuestModelRequest {
  return {
    schemaVersion: "factory.guest-model-request.v1",
    operationId: "run:node:0:0",
    operationIndex: 0,
    model: pin,
    messages: [{ role: "user", text: "hello" }],
    maxOutputTokens: 256,
    ...overrides,
  } as FactoryGuestModelRequest;
}

/** Drains the microtask queue so a pending call has certainly reached its seam. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
}

function broker(options: { complete?: () => Promise<FactoryModelCompletion>; journal?: FactoryGuestModelJournal } = {}) {
  const calls: string[] = [];
  const memory = createFactoryMemoryGuestModelJournal();
  const journal: FactoryGuestModelJournal = options.journal ?? {
    claim: memory.claim,
    record: async (a, r, c) => { calls.push("record"); await memory.record(a, r, c); },
    fail: async (a, r, reason) => { calls.push("fail"); await memory.fail(a, r, reason); },
  };
  const instance = createFactoryGuestModelBroker({
    provider: { complete: async () => { calls.push("provider"); return options.complete ? options.complete() : completion; } },
    journal,
  });
  return { instance, calls, recorded: memory.recorded };
}

test("a well-formed call reaches the provider and its cost is recorded before the guest is answered", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const memory = createFactoryMemoryGuestModelJournal();
  const instance = createFactoryGuestModelBroker({
    provider: { complete: async () => completion },
    journal: { claim: memory.claim, record: async (a, r, c) => { await held; await memory.record(a, r, c); }, fail: memory.fail },
  });

  let answered = false;
  const pending = instance.call(attempt(), request()).then(response => { answered = true; return response; });
  await drain();
  // W03c settles from the recording, so a cost the product has not yet written
  // is a cost the guest must not yet have been told about.
  expect(answered).toBe(false);
  expect(memory.recorded).toEqual([]);

  release?.();
  expect(await pending).toEqual({
    schemaVersion: "factory.guest-model-response.v1", status: "completed", operationId: "run:node:0:0",
    text: "the whole answer", providerReceiptDigest: "b".repeat(64), usage,
  });
  expect(memory.recorded).toEqual([{ operationId: "run:node:0:0", providerReceiptDigest: "b".repeat(64), usage }]);
});

test("a model other than the attempt's pin is refused without reaching the provider", async () => {
  const { instance, calls, recorded } = broker();
  const other = await instance.call(attempt(), request({ model: { ...pin, model: "some-other-model" } }));
  expect(other).toMatchObject({ status: "refused", refusal: { code: "model_pin_mismatch" } });
  // An attempt with no pin at all cannot have a model called on its behalf.
  // Proven unpinned first, so this can never pass against a pinned attempt.
  expect(attempt(null).model).toBeUndefined();
  expect(await instance.call(attempt(null), request())).toMatchObject({ status: "refused", refusal: { code: "model_pin_mismatch" } });
  expect(calls).toEqual([]);
  expect(recorded).toEqual([]);
});

test("an oversized input is refused before the provider, as is a malformed payload", async () => {
  const { instance, calls } = broker();
  const huge = await instance.call(attempt(), request({ messages: [{ role: "user", text: "x".repeat(40_000) }] }));
  expect(huge).toMatchObject({ status: "refused", refusal: { code: "input_too_large" } });
  expect(await instance.call(attempt(), { schemaVersion: "wrong" })).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
  expect(await instance.call(attempt(), request({ maxOutputTokens: 1_000_000 }))).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
  expect(calls).toEqual([]);
});

test("a second call for one operation is refused while the first is in flight, and again once it settled", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { instance, calls } = broker({ complete: async () => { await held; return completion; } });
  const first = instance.call(attempt(), request());
  await drain();
  expect(calls).toEqual(["provider"]);
  expect(await instance.call(attempt(), request())).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });

  release?.();
  expect((await first).status).toBe("completed");
  // The durable claim outlives the call: an operation that already settled can
  // never call a model again, however long ago it finished.
  expect(await instance.call(attempt(), request())).toMatchObject({ status: "refused", refusal: { code: "operation_settled" } });
  expect(calls).toEqual(["provider", "record"]);
});

test("a provider failure is a typed refusal, and nothing is recorded for it", async () => {
  const { instance, calls, recorded } = broker({ complete: async () => { throw new Error("provider_not_configured"); } });
  const refused = await instance.call(attempt(), request());
  expect(refused).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable", message: "provider_not_configured" } });
  // C10: an unavailable model is a readiness failure, never a substitution.
  expect(refused).not.toHaveProperty("text");
  expect(recorded).toEqual([]);
  // The claim is released as a failure rather than left dispatched forever.
  expect(calls).toEqual(["provider", "fail"]);
});

test("a refusal survives a release that itself fails, leaving the operation for reconciliation", async () => {
  const memory = createFactoryMemoryGuestModelJournal();
  const instance = createFactoryGuestModelBroker({
    provider: { complete: async () => { throw new Error("provider gone"); } },
    journal: { claim: memory.claim, record: memory.record, fail: async () => { throw new Error("journal unavailable"); } },
  });
  expect(await instance.call(attempt(), request())).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable", message: "provider gone" } });
  // The operation stays claimed, so nothing else can repeat the effect while
  // `reconcileLate` has not settled it.
  expect(await instance.call(attempt(), request())).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });
});

test("a call whose cost cannot be recorded is refused rather than answered", async () => {
  const calls: string[] = [];
  const memory = createFactoryMemoryGuestModelJournal();
  const instance = createFactoryGuestModelBroker({
    provider: { complete: async () => { calls.push("provider"); return completion; } },
    journal: { claim: memory.claim, record: async () => { throw new Error("journal unavailable"); }, fail: memory.fail },
  });
  const refused = await instance.call(attempt(), request());
  // The provider did run, so the cost is real; answering anyway would hand the
  // guest a result W03c can never settle. A refusal is the honest outcome.
  expect(calls).toEqual(["provider"]);
  expect(refused).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable", message: "journal unavailable" } });
  expect(refused).not.toHaveProperty("text");
  expect(memory.recorded).toEqual([]);
});

test("an answer too large for the guest frame is refused after its cost is recorded", async () => {
  const oversize: FactoryModelCompletion = { ...completion, text: "y".repeat(200_000) };
  const { instance, recorded } = broker({ complete: async () => oversize });
  const refused = await instance.call(attempt(), request());
  expect(refused).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable" } });
  expect(refused).not.toHaveProperty("text");
  // Truncating would be a silent substitution, and the provider still charged
  // for what it produced, so the receipt is settled and the guest is refused.
  expect(recorded).toEqual([{ operationId: "run:node:0:0", providerReceiptDigest: "b".repeat(64), usage }]);
});

test("the one seam routes a model payload here and everything else to its delegate", async () => {
  expect(isFactoryGuestModelPayload(request())).toBe(true);
  for (const payload of [null, "text", ["a"], { schemaVersion: "factory.validator-claims.v1" }]) expect(isFactoryGuestModelPayload(payload)).toBe(false);

  const seen: unknown[] = [];
  const memory = createFactoryMemoryGuestModelJournal();
  const withDelegate = createFactoryGuestModelBroker({
    provider: { complete: async () => completion },
    journal: memory,
    delegate: { invoke: async (_request, payload) => { seen.push(payload); return { accepted: true }; } },
  });
  expect(await withDelegate.invoke(attempt(), request())).toMatchObject({ status: "completed" });
  expect(await withDelegate.invoke(attempt(), { kind: "validator-report" })).toEqual({ accepted: true });
  expect(seen).toEqual([{ kind: "validator-report" }]);

  // Without a delegate a non-model payload is denied, not silently accepted.
  const alone = createFactoryGuestModelBroker({ provider: { complete: async () => completion }, journal: createFactoryMemoryGuestModelJournal() });
  await expect(alone.invoke(attempt(), { kind: "validator-report" })).rejects.toThrow("no other route");
});
