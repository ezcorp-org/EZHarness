/**
 * Defect 2 (W01h): the durable epoch is written by the transition that raises it.
 *
 * A stop the kernel begins itself moves the kernel's cancellation epoch from 0
 * to 1. Only a user cancel used to move the run fence's durable epoch, so after
 * a run deadline or a failed command every `cancel-node` was refused
 * `factory_command_stale` and the run sat in `stopping` for ever (the W19a merge
 * batch, 2026-09-25). Each case here starts one kind of stop, and proves the
 * durable epoch followed it, the stop's `cancel-node` is accepted, a command of
 * the old epoch is still refused, and the run reaches a terminal status.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { advanceKernel, type KernelEvent } from "@ezcorp/factory-sdk";
import type { KernelCommand } from "@ezcorp/factory-sdk/kernel-types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import type { FactoryPrincipal } from "../factory/grants";
import { FACTORY_STOPPED_CANCELLATION_EPOCH, FactoryRunCancellationEpochError, advanceFactoryRunCancellationEpochInTransaction } from "../factory/run-cancellation-epoch";
import { FactoryRunTransitionProjector } from "../factory/run-transition-projector";
import { failedFactoryRunnerResult } from "../factory/runner/native";
import type { FactoryTaskResourceProfile } from "../factory/task-admission";
import { createFactoryLiveAttemptWorld, type FactoryLiveAttempt, type FactoryLiveAttemptWorld } from "./helpers/factory-live-attempt-world";
import { setupTestDb } from "./helpers/test-pglite";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.UTC(2030, 0, 1);
const tenantId = "epoch-tenant";
const projectId = "epoch-project";
const service = { tenantId, subject: "orchestration" };
const principal: FactoryPrincipal = { kind: "user", id: "epoch-owner", authentication: "session" };
const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let world: FactoryLiveAttemptWorld;
beforeAll(async () => {
  fixture = await setupTestDb();
  world = await createFactoryLiveAttemptWorld(fixture, { label: "epoch", tenantId, projectId, principal, factoryId: "epoch-factory", hostId: "epoch-host", now, profile, service, hostKeys });
});
afterAll(async () => { await fixture.pglite.close(); });

const durableEpoch = async (runId: string) => Number(rows<{ cancellation_epoch: number | string }>(await fixture.db.execute(sql`SELECT cancellation_epoch FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND run_id=${runId}`))[0]!.cancellation_epoch);
const lifecycleStatus = async (runId: string) => rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND run_id=${runId}`))[0]!.status;

/** The guest ended without an answer and W01h recorded it: a failed terminal row with a measured zero usage. */
async function guestLost(attempt: FactoryLiveAttempt): Promise<void> {
  await attempt.launches.recordTerminal(attempt.attemptId, failedFactoryRunnerResult(
    { operations: [], journalCursor: -1, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" } },
    { code: "RUNNER_CONTAINER_EXIT", message: "killed at its deadline", retryable: true },
  ));
}

/**
 * Commits `event` as the attempt's next transition, drives the `cancel-node` it
 * issued through the real stop store at `clockMs`, and commits the stop.
 */
async function stopThrough(attempt: FactoryLiveAttempt, event: KernelEvent, clockMs: number, sequence = 3) {
  const stopping = advanceKernel(attempt.compiled, attempt.state.nextState, event);
  await persistTransition(attempt.identity, sequence, event, stopping.nextState, stopping.commands, undefined, attempt.activities);
  // While the run is stopping, a command of the old epoch is refused by the fence itself.
  const oldEpoch = await oldEpochRefusal(attempt);
  const cancel = stopping.commands.find((command): command is Extract<KernelCommand, { kind: "cancel-node" }> => command.kind === "cancel-node");
  if (!cancel) throw new Error("the stop issued no cancel-node");
  const { stops } = world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request, { stoppedAtMs: clockMs })), world.settlingPool(), undefined, undefined, () => clockMs);
  const receipt = await stops.stop(service, { ...attempt.identity, commandId: cancel.id });
  if (receipt.state !== "stopped") throw new Error(`the stop did not settle: ${receipt.state}`);
  const stopped = advanceKernel(attempt.compiled, stopping.nextState, receipt.event);
  await persistTransition(attempt.identity, sequence + 1, receipt.event, stopped.nextState, stopped.commands, undefined, attempt.activities);
  await new FactoryRunTransitionProjector(fixture.db, tenantId, attempt.transitions, world.lifecycle).project(world.runKey(attempt.run.runId));
  return { stopping, cancel, receipt, stopped, oldEpoch };
}

/** A command of the epoch the stop left behind: the attempt's own `dispatch-node`, which carries epoch 0. */
async function oldEpochRefusal(attempt: FactoryLiveAttempt): Promise<unknown> {
  return fixture.db.transaction(transaction => attempt.authority.withCurrentInTransaction(transaction, service, attempt.dispatchReference, async () => "accepted"))
    .then(() => undefined, (error: unknown) => (error as { code?: string }).code);
}

describe("every self-started stop moves the durable epoch with the kernel", () => {
  test("the stopped epoch is the kernel's own: 0 before a stop, one step after it", async () => {
    const attempt = await world.launchedAttempt(false);
    expect(attempt.state.nextState.cancellationEpoch).toBe(0);
    const state = attempt.state.nextState;
    const stopping = advanceKernel(attempt.compiled, state, { kind: "timer-expired", id: "pin-deadline", atMs: state.runDeadlineAtMs, commandId: state.runTimerId! });
    expect(stopping.nextState.cancellationEpoch).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
  });

  test("run deadline: the cancel-node is accepted, the old epoch is refused, and the run fails by name", async () => {
    const attempt = await world.launchedAttempt(false);
    await guestLost(attempt);
    const state = attempt.state.nextState;
    const { cancel, receipt, stopped, oldEpoch } = await stopThrough(attempt, { kind: "timer-expired", id: "run-deadline", atMs: state.runDeadlineAtMs, commandId: state.runTimerId! }, state.runDeadlineAtMs + 1);
    expect(cancel.cancellationEpoch).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    expect(receipt.event).toMatchObject({ kind: "attempt-stopped" });
    // A settled stop is certain: the event carries no uncertainty.
    expect(receipt.event.kind === "attempt-stopped" && receipt.event.uncertain).toBeFalsy();
    expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "fail-run", error: "RUN_DEADLINE_EXPIRED" }));
    expect(await lifecycleStatus(attempt.run.runId)).toBe("failed");
    expect(oldEpoch).toBe("factory_command_stale");
  });

  test("command-failed: the same, and the run fails with the command's typed reason", async () => {
    const attempt = await world.launchedAttempt(false);
    await guestLost(attempt);
    const dispatch = attempt.state.commands.find(command => command.kind === "dispatch-node")!;
    const { stopped, oldEpoch } = await stopThrough(attempt, { kind: "command-failed", id: `${dispatch.id}:command-failed`, atMs: now, commandId: dispatch.id, error: "FACTORY_COMMAND_FAILED: dispatch-node refused" }, now);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    expect(stopped.commands).toContainEqual(expect.objectContaining({ kind: "fail-run", error: "FACTORY_COMMAND_FAILED: dispatch-node refused" }));
    expect(await lifecycleStatus(attempt.run.runId)).toBe("failed");
    expect(oldEpoch).toBe("factory_command_stale");
  });

  test("a transition of any interpreter raises the run's epoch, and a lower one never lowers it", async () => {
    const attempt = await world.launchedAttempt(false);
    const scope = { tenantId, projectId, runId: attempt.run.runId };
    await fixture.db.transaction(transaction => advanceFactoryRunCancellationEpochInTransaction(transaction, scope, FACTORY_STOPPED_CANCELLATION_EPOCH));
    await fixture.db.transaction(transaction => advanceFactoryRunCancellationEpochInTransaction(transaction, scope, 0));
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    await expect(fixture.db.transaction(transaction => advanceFactoryRunCancellationEpochInTransaction(transaction, scope, -1))).rejects.toBeInstanceOf(FactoryRunCancellationEpochError);
    await expect(fixture.db.transaction(transaction => advanceFactoryRunCancellationEpochInTransaction(transaction, scope, 1.5))).rejects.toMatchObject({ code: "factory_epoch_invalid" });
  });
});

describe("a user cancel and a kernel stop agree on one counter, in either order", () => {
  test("user cancel first, then the run deadline: one step, and the stop settles", async () => {
    const attempt = await world.launchedAttempt(false);
    await guestLost(attempt);
    const { reference, advanced } = await world.cancelled(attempt);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    expect(advanced.nextState.cancellationEpoch).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    // The deadline arrives while the kernel is already stopping: it moves nothing.
    const lateDeadline = { kind: "timer-expired" as const, id: "late-deadline", atMs: advanced.nextState.runDeadlineAtMs, commandId: advanced.nextState.runTimerId! };
    const late = advanceKernel(attempt.compiled, advanced.nextState, lateDeadline);
    await persistTransition(attempt.identity, 4, lateDeadline, late.nextState, late.commands, undefined, attempt.activities);
    expect(late.nextState.cancellationEpoch).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    const clock = advanced.nextState.runDeadlineAtMs + 1;
    const { stops } = world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request, { stoppedAtMs: clock })), world.settlingPool(), undefined, undefined, () => clock);
    expect((await stops.stop(service, reference)).state).toBe("stopped");
  });

  test("the run deadline first, then a user cancel: still one step, and the deadline's stop settles", async () => {
    const attempt = await world.launchedAttempt(false);
    await guestLost(attempt);
    const state = attempt.state.nextState;
    const deadline = { kind: "timer-expired" as const, id: "first-deadline", atMs: state.runDeadlineAtMs, commandId: state.runTimerId! };
    const stopping = advanceKernel(attempt.compiled, state, deadline);
    await persistTransition(attempt.identity, 3, deadline, stopping.nextState, stopping.commands, undefined, attempt.activities);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    await world.lifecycle.cancel(principal, world.runKey(attempt.run.runId), attempt.run.revision, `epoch-cancel-after-${attempt.run.runId}`);
    expect(await durableEpoch(attempt.run.runId)).toBe(FACTORY_STOPPED_CANCELLATION_EPOCH);
    const cancel = stopping.commands.find(command => command.kind === "cancel-node")!;
    const clock = state.runDeadlineAtMs + 1;
    const { stops } = world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request, { stoppedAtMs: clock })), world.settlingPool(), undefined, undefined, () => clock);
    expect((await stops.stop(service, { ...attempt.identity, commandId: cancel.id })).state).toBe("stopped");
  });
});
