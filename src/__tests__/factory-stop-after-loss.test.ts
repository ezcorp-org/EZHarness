/**
 * W01h fix round, found on W01i's real factory-services lane: a stop sealed
 * before any terminal result carries reason `cancelled`. W01h's lost-result
 * path then recorded a failed terminal result, every settlement re-derived
 * `failed`, refused the stop as corrupt, and the settlement role retried it
 * about once a second for as long as the process lived.
 *
 * The rulings: the first writer owns the attempt's end, so a lost result after
 * a sealed stop is that stop's evidence, not a terminal result; and a stop
 * whose facts no longer verify is marked once as a reconciliation item, never
 * retried.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryStopReconciliationError, factoryStopSettlementDriver } from "../factory/dispatch-composition";
import type { FactoryPrincipal } from "../factory/grants";
import { failedFactoryRunnerResult } from "../factory/runner/native";
import type { FactoryTaskResourceProfile } from "../factory/task-admission";
import { createFactoryLiveAttemptWorld, type FactoryLiveAttempt, type FactoryLiveAttemptWorld } from "./helpers/factory-live-attempt-world";
import { setupTestDb } from "./helpers/test-pglite";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.UTC(2030, 0, 1);
const tenantId = "loss-tenant";
const projectId = "loss-project";
const service = { tenantId, subject: "orchestration" };
const principal: FactoryPrincipal = { kind: "user", id: "loss-owner", authentication: "session" };
const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let world: FactoryLiveAttemptWorld;
beforeAll(async () => {
  fixture = await setupTestDb();
  world = await createFactoryLiveAttemptWorld(fixture, { label: "loss", tenantId, projectId, principal, factoryId: "loss-factory", hostId: "loss-host", now, profile, service, hostKeys });
});
afterAll(async () => { await fixture.pglite.close(); });

/** The result W01h's runtime builds when the guest's answer is lost: failed, typed, over an empty journal. */
const lostResult = () => failedFactoryRunnerResult({ operations: [], journalCursor: -1 }, { code: "RUNNER_CONTAINER_EXIT", message: "Worker exited before response; container_exited: Container ended with exit code 1", retryable: true });

/** A user cancel, and its stop sealed while the host does not answer: durably uncertain, reason `cancelled`. */
async function sealedStop(attempt: FactoryLiveAttempt) {
  const { reference } = await world.cancelled(attempt);
  const hung = world.stopHarness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, world.settlingPool(), undefined, 1);
  expect((await hung.stops.stop(service, reference)).state).toBe("uncertain");
  return reference;
}

const evidence = async (attemptId: string) => rows<{ action: string; target: string; metadata: Record<string, unknown> }>(await fixture.db.execute(sql`SELECT action, target, metadata FROM audit_log WHERE id=${`factory-attempt-exit-after-stop:${attemptId}`}`));
const reconcile = async (attemptId: string) => rows<{ reconcile_json: string | null }>(await fixture.db.execute(sql`SELECT reconcile_json FROM factory_task_stops WHERE attempt_id=${attemptId}`))[0]?.reconcile_json;

describe("a stop sealed first owns the attempt's end", () => {
  test("the lost result becomes the stop's evidence, and the stop settles with its sealed reason", async () => {
    const attempt = await world.launchedAttempt(false);
    const reference = await sealedStop(attempt);

    const recorded = await attempt.launches.recordLostTerminal(attempt.attemptId, lostResult());
    expect(recorded).toEqual({ state: "stop-sealed", cancelCommandId: reference.commandId, sealedReason: "cancelled" });
    expect(await attempt.launches.terminalResult(attempt.attemptId)).toBeUndefined();
    expect(await evidence(attempt.attemptId)).toEqual([{
      action: "factory.attempt.exit_after_stop", target: reference.commandId,
      metadata: { attemptId: attempt.attemptId, sealedReason: "cancelled", observedStatus: "failed", code: "RUNNER_CONTAINER_EXIT", message: "Worker exited before response; container_exited: Container ended with exit code 1" },
    }]);

    // The host answers now: the stop settles, certain, with the reason it was sealed with.
    const settled = await world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request)), world.settlingPool()).stops.stop(service, reference);
    expect(settled.state).toBe("stopped");
    expect(settled.state === "stopped" && settled.stopReceipt?.reason).toBe("cancelled");
    expect(await reconcile(attempt.attemptId)).toBeNull();
  });

  test("with no stop sealed, the lost result is the attempt's terminal result, and a later one never replaces it", async () => {
    const attempt = await world.launchedAttempt(false);
    const first = await attempt.launches.recordLostTerminal(attempt.attemptId, lostResult());
    expect(first).toMatchObject({ state: "recorded", result: { status: "failed", error: { code: "RUNNER_CONTAINER_EXIT" } } });
    expect(await attempt.launches.terminalResult(attempt.attemptId)).toEqual(first.state === "recorded" ? first.result : undefined);
    const other = failedFactoryRunnerResult({ operations: [], journalCursor: -1 }, { code: "RUNNER_SUPERVISOR_LOST", message: "later", retryable: true });
    expect(await attempt.launches.recordLostTerminal(attempt.attemptId, other)).toEqual(first);
    expect(await evidence(attempt.attemptId)).toEqual([]);
  });
});

describe("a stop whose facts no longer verify is a reconciliation item, not a hot loop", () => {
  test("the settlement marks it once, names both reasons, and never lists it again", async () => {
    const attempt = await world.launchedAttempt(false);
    const reference = await sealedStop(attempt);
    // The previous lost-result path: a terminal result written after the stop was sealed.
    await attempt.launches.recordTerminal(attempt.attemptId, lostResult());

    const calls = { count: 0 };
    const { stops } = world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request), calls), world.settlingPool());
    const reports: Array<{ role: string; error: unknown }> = [];
    const driver = factoryStopSettlementDriver(fixture.db, stops, service, (role, error) => { reports.push({ role, error }); });

    await driver.step(new AbortController().signal);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.role).toBe(`stop-settlement:fault:${attempt.attemptId}`);
    const loud = reports[0]!.error as FactoryStopReconciliationError;
    expect(loud).toBeInstanceOf(FactoryStopReconciliationError);
    expect(loud.message).toContain(`stop ${reference.commandId} of attempt ${attempt.attemptId}`);
    expect(loud.message).toContain("sealed with reason cancelled and its durable facts now give failed");
    expect(JSON.parse(await reconcile(attempt.attemptId) ?? "null")).toMatchObject({ code: "factory_task_stop_corrupt", sealedReason: "cancelled", derivedReason: "failed", markedAtMs: now });

    // The next passes list nothing for it: no second report, no second host call.
    for (let pass = 0; pass < 3; pass += 1) await driver.step(new AbortController().signal);
    expect(reports).toHaveLength(1);
    expect(calls.count).toBe(0);
    // Marking again changes nothing: it is marked once.
    await stops.markForReconciliation(service, reference, new Error("again"));
    expect(JSON.parse(await reconcile(attempt.attemptId) ?? "null")).toMatchObject({ sealedReason: "cancelled", derivedReason: "failed" });
  });
});
