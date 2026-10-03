import { expect, test } from "bun:test";
import type { FactoryGuestModelRequest, FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { FactoryAttemptLivenessError, type FactoryExecutionJournal } from "../executions";
import { factoryLaunchRequest } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import { createFactoryJournalGuestModelJournal, FACTORY_GUEST_MODEL_EVIDENCE_PARKED } from "./guest-model-journal";

/**
 * W03f: a provider that answers after its attempt's stop was confirmed.
 *
 * The journal refuses the settlement of an attempt that is no longer live. The
 * product's guest-model journal then parks the provider's receipt and usage on
 * the still-dispatched operation through `reconcileLate`, and only when there
 * is such evidence. These cases pin every branch against a journal double; the
 * PostgreSQL stop suite drives the same path end to end.
 */

const digest = `sha256:${"a".repeat(64)}`;
const pin: FactoryModelPin = { provider: "ollama", model: "qwen3:1.7b", configurationDigest: digest, configuration: {}, policyDigest: digest, policy: {} };
// The journal derives the authority from the request alone; a pin is the broker's concern.
const attempt = factoryLaunchRequest({ attemptId: "attempt-late" }) as FactoryRunnerRequest;
const request = { schemaVersion: "factory.guest-model-request.v1", operationId: "run:node:0:0", operationIndex: 0, model: pin, messages: [{ role: "user", text: "hello" }], maxOutputTokens: 64 } as FactoryGuestModelRequest;
const evidence = { providerReceiptDigest: "f".repeat(64), usage: { kind: "measured" as const, inputTokens: 3, outputTokens: 1, computeMs: 7, costMicros: "9" } };
const stopped = new FactoryAttemptLivenessError("factory_attempt_not_live", "Factory attempt is stale, cancelled, or expired.");

function journal(options: { settle?: () => Promise<void>; reconcileLate?: () => Promise<void> }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const double = {
    async prepare() {}, async dispatch() { return { claimed: true }; }, async operation() { return { state: "dispatched" }; },
    async settle(...args: unknown[]) { calls.push({ method: "settle", args }); await options.settle?.(); },
    async reconcileLate(...args: unknown[]) { calls.push({ method: "reconcileLate", args }); await options.reconcileLate?.(); },
  } as unknown as Pick<FactoryExecutionJournal, "prepare" | "dispatch" | "settle" | "operation" | "reconcileLate">;
  const guest = createFactoryJournalGuestModelJournal({ journal: double, workspace: { checkpoint: async () => ({ artifactId: "checkpoint", digest, encodedBytes: 1, journalCursor: 0 }) } });
  return { guest, calls };
}

test("a live attempt settles its failed call directly, and parks nothing", async () => {
  const { guest, calls } = journal({});
  const operation = await guest.fail(attempt, request, { code: "provider_rate_limited", message: "429", evidence });
  expect(operation).toMatchObject({ state: "failed", usage: evidence.usage, providerReceiptDigest: evidence.providerReceiptDigest });
  expect(calls.map(call => call.method)).toEqual(["settle"]);
});

test("a stopped attempt parks exactly the receipt and the usage of a late answer, held or failed", async () => {
  const held = journal({ settle: async () => { throw stopped; } });
  await held.guest.hold(attempt, request, { text: "late", ...evidence });
  expect(held.calls.map(call => call.method)).toEqual(["settle", "reconcileLate"]);
  expect(held.calls[1]!.args.slice(1)).toEqual([request.operationId, evidence]);

  const failed = journal({ settle: async () => { throw stopped; } });
  await expect(failed.guest.fail(attempt, request, { code: "provider_unavailable", message: "404", evidence })).rejects.toThrow(FACTORY_GUEST_MODEL_EVIDENCE_PARKED);
  expect(failed.calls.map(call => call.method)).toEqual(["settle", "reconcileLate"]);
  expect(failed.calls[1]!.args.slice(1)).toEqual([request.operationId, evidence]);
});

test("without evidence, or when parking is refused too, the original refusal stands", async () => {
  const bare = journal({ settle: async () => { throw stopped; } });
  await expect(bare.guest.fail(attempt, request, { code: "provider_unavailable", message: "socket hang up" })).rejects.toBe(stopped);
  expect(bare.calls.map(call => call.method)).toEqual(["settle"]);

  const both = journal({ settle: async () => { throw stopped; }, reconcileLate: async () => { throw new Error("Late factory receipt does not match a dispatched operation."); } });
  await expect(both.guest.hold(attempt, request, { text: "late", ...evidence })).rejects.toBe(stopped);
  await expect(both.guest.fail(attempt, request, { code: "provider_unavailable", message: "404", evidence })).rejects.toBe(stopped);
});

test("validator L1: a settle failure that is not the liveness refusal propagates as itself, and nothing is parked", async () => {
  const lost = new Error("Connection terminated unexpectedly");
  for (const settle of [async () => { throw lost; }]) {
    const failed = journal({ settle });
    const error = await failed.guest.fail(attempt, request, { code: "provider_unavailable", message: "404", evidence }).then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBe(lost);
    expect(String((error as Error).message)).not.toContain(FACTORY_GUEST_MODEL_EVIDENCE_PARKED);
    expect(failed.calls.map(call => call.method)).toEqual(["settle"]);

    const held = journal({ settle });
    await expect(held.guest.hold(attempt, request, { text: "answer", ...evidence })).rejects.toBe(lost);
    expect(held.calls.map(call => call.method)).toEqual(["settle"]);
  }
  // Each form of the liveness refusal still parks: the journal's own, and a stopped or re-fenced run.
  for (const refusal of [stopped, Object.assign(new Error("factory_run_stopped"), { code: "factory_run_stopped" }), Object.assign(new Error("factory_run_fence_changed"), { code: "factory_run_fence_changed" })]) {
    const parked = journal({ settle: async () => { throw refusal; } });
    await parked.guest.hold(attempt, request, { text: "late", ...evidence });
    expect(parked.calls.map(call => call.method)).toEqual(["settle", "reconcileLate"]);
  }
});
