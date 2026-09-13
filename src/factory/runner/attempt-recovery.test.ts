import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { Runner, RunnerExecution, RunnerInspection, StartRequest } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { generateKeyPairSync } from "node:crypto";
import { createFactoryLaunchFixture, factoryLaunchCompletedResult, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, type FactoryLaunchFixture } from "../../__tests__/helpers/factory-attempt-launch-fixture";
import type { PoolLease } from "../pool/ledger";
import { FactoryDatabaseAttemptLaunchStore, IsolatedFactoryAttemptRuntime, factoryTerminalResultDigest, signFactoryPhysicalStopReceipt, type FactoryUnsignedPhysicalStopReceipt } from "./attempt-runtime";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "recovery-host-key", hostKeys.privateKey);

/** Counts every physical start and every guest invocation so a duplicate cannot pass unseen. */
class CountingRunner implements Runner {
  starts = 0;
  attaches = 0;
  invocations = 0;
  private state: RunnerInspection["state"] = "unknown";
  constructor(private readonly result: FactoryRunnerResult, private readonly failAfterInvoke = false) {}
  async build(): Promise<never> { throw new Error("build is not part of attempt recovery"); }
  async collectArtifacts(): Promise<never> { throw new Error("artifact collection is not part of attempt recovery"); }
  async inspect(id: string): Promise<RunnerInspection> { return { id, state: this.state, diagnostics: [] }; }
  async cancel(id: string): Promise<void> { void id; this.state = "cancelled"; }
  async start(input: StartRequest): Promise<RunnerExecution> {
    this.starts += 1;
    this.state = "running";
    return this.execution(input.workerId);
  }
  async attach(input: StartRequest): Promise<RunnerExecution> {
    this.attaches += 1;
    return { workerId: input.workerId, request: async () => { throw new Error("a reattached guest must never receive another invocation"); }, close: async () => {}, onNotification: () => () => {} };
  }
  private execution(workerId: string): RunnerExecution {
    return {
      workerId,
      request: async (method) => {
        if (method !== "extension/invoke") throw new Error(`unexpected guest method ${method}`);
        this.invocations += 1;
        if (this.failAfterInvoke) { this.state = "cancelled"; }
        return this.result;
      },
      close: async () => {},
      onNotification: () => () => {},
    };
  }
}

const pool = { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease };
let renewedLease: PoolLease;
let fixture: FactoryLaunchFixture;
let request: FactoryRunnerRequest;

beforeEach(async () => {
  request = factoryLaunchRequest();
  renewedLease = { ...factoryLaunchLease, tenantId: request.authority.tenantId, fence: "recovery-fence", deadlineAt: new Date(Date.now() + 600_000), resources: {} };
  fixture = await createFactoryLaunchFixture(request);
});
afterEach(async () => { await fixture.close(); });

function runtime(runner: Runner, options: { presentStopReceipt?: () => Promise<void>; broker?: () => Promise<unknown> } = {}): IsolatedFactoryAttemptRuntime {
  return new IsolatedFactoryAttemptRuntime({
    runner,
    launches: new FactoryDatabaseAttemptLaunchStore(fixture.db),
    pool,
    broker: { invoke: options.broker ?? (async () => { throw new Error("recovery must not reach the broker"); }) },
    signStopReceipt,
    presentStopReceipt: options.presentStopReceipt ?? (async () => {}),
    mintAttemptToken: async () => "minted-attempt-token",
  });
}

/** The database constraint a statement violated, so a test proves the schema and not only the code. */
async function violatedConstraint(statement: ReturnType<typeof sql>): Promise<string | undefined> {
  try {
    await fixture.db.execute(statement);
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint;
  }
  return undefined;
}

test("a fresh gateway reads the same terminal result without a second invocation", async () => {
  const completed = factoryLaunchCompletedResult();
  const runner = new CountingRunner(completed);
  const first = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(first.disposition).toBe("started");
  expect(await first.wait()).toEqual(completed);
  expect(runner.starts).toBe(1);
  expect(runner.invocations).toBe(1);

  const recovered = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(recovered.disposition).toBe("terminal");
  expect(recovered.invocationId).toBe(first.invocationId);
  expect(await recovered.wait()).toEqual(completed);
  expect(runner.starts).toBe(1);
  expect(runner.invocations).toBe(1);
  expect(runner.attaches).toBe(0);
});

test("the result is durable before it is acknowledged, so a crash at the acknowledgement boundary still recovers it", async () => {
  const completed = factoryLaunchCompletedResult("acknowledge");
  const runner = new CountingRunner(completed);
  const crashing = runtime(runner, { presentStopReceipt: async () => { throw new Error("gateway crashed before acknowledging the stop receipt"); } });
  const opened = await crashing.open(request, factoryLaunchLease, factoryLaunchPackage(request));
  await expect(opened.wait()).rejects.toThrow("crashed before acknowledging");
  expect(runner.invocations).toBe(1);

  const stored = await new FactoryDatabaseAttemptLaunchStore(fixture.db).terminalResult(request.authority.attemptId);
  expect(stored).toEqual(completed);
  const recovered = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(await recovered.wait()).toEqual(completed);
  expect(runner.invocations).toBe(1);
});

test("a crash before the result boundary leaves no result and refuses to invoke again", async () => {
  const runner = new CountingRunner(factoryLaunchCompletedResult());
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
  await store.claimStart(request.authority.attemptId);
  const recovered = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(recovered.disposition).toBe("uncertain");
  await expect(recovered.wait()).rejects.toThrow("outcome is uncertain");
  expect(await store.terminalResult(request.authority.attemptId)).toBeUndefined();
  expect(runner.starts).toBe(0);
  expect(runner.invocations).toBe(0);
});

test("a losing concurrent claimant returns the winner's exact result instead of inventing one", async () => {
  const completed = factoryLaunchCompletedResult("concurrent");
  const runner = new CountingRunner(completed);
  const winner = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  const loser = await runtime(runner).open(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(loser.disposition).toBe("attached");
  await expect(loser.wait()).rejects.toThrow("durable terminal result");

  expect(await winner.wait()).toEqual(completed);
  expect(await loser.wait()).toEqual(completed);
  expect(runner.starts).toBe(1);
  expect(runner.invocations).toBe(1);
});

test("a second different terminal result for the same attempt is rejected and the first survives", async () => {
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  const first = factoryLaunchCompletedResult("first");
  await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
  expect(await store.recordTerminal(request.authority.attemptId, first)).toEqual(first);
  expect(await store.recordTerminal(request.authority.attemptId, first)).toEqual(first);
  await expect(store.recordTerminal(request.authority.attemptId, factoryLaunchCompletedResult("second"))).rejects.toThrow("already recorded a different terminal result");
  expect(await store.terminalResult(request.authority.attemptId)).toEqual(first);
});

test("a corrupted durable result is rejected rather than replayed", async () => {
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  const completed = factoryLaunchCompletedResult("corrupt");
  await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
  await store.recordTerminal(request.authority.attemptId, completed);
  const tampered = { ...completed, journalCursor: 5, workspaceCheckpoint: { ...completed.workspaceCheckpoint!, journalCursor: 5 } };
  await fixture.db.execute(sql`UPDATE factory_attempt_launches SET terminal_result_json=${canonicalJson(tampered)}::jsonb WHERE attempt_id=${request.authority.attemptId}`);
  await expect(store.terminalResult(request.authority.attemptId)).rejects.toThrow("does not match its durable digest");
  expect(await violatedConstraint(sql`UPDATE factory_attempt_launches SET terminal_result_json=NULL,terminal_result_digest=${factoryTerminalResultDigest(completed)} WHERE attempt_id=${request.authority.attemptId}`)).toBe("factory_attempt_launches_terminal_result_paired_check");
  expect(await violatedConstraint(sql`UPDATE factory_attempt_launches SET terminal_result_digest='not-a-digest' WHERE attempt_id=${request.authority.attemptId}`)).toBe("factory_attempt_launches_terminal_result_digest_check");
});

test("a different attempt number is a different invocation with its own durable result", async () => {
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  const retry = factoryLaunchRequest({ attemptId: "attempt-recovery-retry", attemptNumber: 4 });
  await fixture.admit(retry);
  const original = await store.prepare(request, factoryLaunchLease, factoryLaunchPackage(request));
  const second = await store.prepare(retry, factoryLaunchLease, factoryLaunchPackage(retry));
  expect(second.invocationId).not.toBe(original.invocationId);
  await store.recordTerminal(request.authority.attemptId, factoryLaunchCompletedResult("original"));
  expect(await store.terminalResult(retry.authority.attemptId)).toBeUndefined();
});

test("recording or reading a terminal result for an absent launch intent fails closed", async () => {
  const store = new FactoryDatabaseAttemptLaunchStore(fixture.db);
  await expect(store.terminalResult("attempt-absent")).rejects.toThrow("launch intent is missing");
  await expect(store.recordTerminal("attempt-absent", factoryLaunchCompletedResult())).rejects.toThrow("launch intent is missing");
  await expect(store.recordTerminal(request.authority.attemptId, { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: 0, operations: [] } as unknown as FactoryRunnerResult)).rejects.toThrow("Factory terminal result is invalid");
});
