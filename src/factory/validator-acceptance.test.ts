import { describe, expect, test } from "bun:test";
import type { TransactionalDb } from "../db/migrations/types";
import { FACTORY_VALIDATOR_ACCEPTANCE_SCAN_LIMIT, FactoryValidatorAcceptance, FactoryValidatorAcceptanceError, factoryValidatorAcceptanceRefusal, type FactoryValidatorAcceptanceOptions } from "./validator-acceptance";
import type { TrustedFactoryCommandReference } from "./trusted-command-gateway";
import type { FactoryProtectedValidatorSchedule } from "./validator-scheduler";

const tenantId = "tenant-acceptance";
const service = { subject: "orchestration", tenantId };
const reference: TrustedFactoryCommandReference = { tenantId, projectId: "project-1", logicalRunId: "run-1", interpreterId: "interpreter-1", commandId: "run-1:accept:request-acceptance:4" };
const schedule = (attemptId: string) => ({ attemptId, reservationId: `reservation-${attemptId}` }) as unknown as FactoryProtectedValidatorSchedule;
const acceptanceEvent = { kind: "node-result", id: `protected-acceptance:${reference.commandId}`, atMs: 1, nodeId: "accept", commandId: reference.commandId, candidateGeneration: 0, attempt: 1, output: { acceptedCandidate: "x" } };

class Coded extends Error { constructor(readonly code: string) { super(code); } }

interface Harness {
  readonly acceptance: FactoryValidatorAcceptance;
  readonly calls: string[];
  readonly enqueued: unknown[];
  readonly reported: { role: string; error: unknown }[];
}

/**
 * A fake of every collaborator, recording the order of calls.
 *
 * `stored` maps an attempt id to its delivery state, or null when no attempt exists; `terminal`
 * names the attempts whose validator settlement has a completed terminal fact.
 */
function harness(overrides: {
  readonly schedules?: readonly FactoryProtectedValidatorSchedule[];
  readonly stored?: Readonly<Record<string, string | null>>;
  readonly terminal?: readonly string[];
  readonly admit?: (attemptId: string) => Promise<unknown>;
  readonly reserveCreated?: boolean;
  readonly record?: () => Promise<unknown>;
  readonly request?: () => Promise<unknown>;
  readonly pending?: readonly Record<string, string>[];
  readonly limit?: number;
} = {}): Harness {
  const calls: string[] = [];
  const enqueued: unknown[] = [];
  const reported: { role: string; error: unknown }[] = [];
  const database = {
    transaction: async (work: (transaction: unknown) => Promise<unknown>) => work("tx"),
    execute: async () => { calls.push("scan"); return { rows: overrides.pending ?? [] }; },
  } as unknown as TransactionalDb;
  const context = { command: { id: reference.commandId, nodeId: "accept", candidateGeneration: 0 }, commandState: { nowMs: 7 }, attempt: { attempt: 1 } };
  const options: FactoryValidatorAcceptanceOptions = {
    database, tenantId, service,
    authority: { withCurrentAcceptanceInTransaction: async (_tx, _service, _reference, work) => { calls.push("authority"); return work("tx" as never, context as never); } },
    scheduler: {
      planInTransaction: async () => { calls.push("plan"); return overrides.schedules ?? []; },
      reserveInTransaction: async (_tx, _service, _reference, value) => { calls.push(`reserve:${value.attemptId}`); return { created: overrides.reserveCreated ?? true }; },
      admitInTransaction: async (_tx, _service, _reference, value) => { calls.push(`admit:${value.attemptId}`); return (overrides.admit ?? (async () => ({})))(value.attemptId) as never; },
    },
    dispatch: { readInTransaction: async (_tx, _service, value) => { calls.push(`terminal:${value.commandId}`); return (overrides.terminal ?? []).includes(value.commandId) ? { reservationId: `reservation-${value.commandId}`, terminal: { terminalFactDigest: `sha256:${"e".repeat(64)}` } } as never : undefined; } },
    budgets: {
      settleInTransaction: async (_tx, key, actual, receipt) => { calls.push(`settle:${key.reservationId}:${actual.costMicros}/${actual.tokens}/${actual.computeMs}:${receipt.slice(0, 8)}`); },
      markUncertainInTransaction: async (_tx, key, reason) => { calls.push(`uncertain:${key.reservationId}:${reason}`); },
    },
    journal: { readCompletedTerminalInTransaction: async () => ({ result: { usage: { kind: "measured", costMicros: "5", inputTokens: 1, outputTokens: 2, computeMs: 7 } } }) as never },
    artifacts: {} as never,
    queue: {
      readInTransaction: async (_tx, _project, attemptId) => {
        const state = overrides.stored?.[attemptId];
        return state === undefined || state === null ? null : { state, reference: { attemptId, tenantId, projectId: "project-1", runId: "run-1", nodeInstanceId: "validator", candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAtMs: 10, reservationId: `reservation-${attemptId}` } } as never;
      },
    },
    effects: {
      recordCurrentCandidate: async () => { calls.push("candidate"); return (overrides.record ?? (async () => ({})))() as never; },
      decideAcceptance: async (_service, _reference, deliver) => {
        calls.push("decide");
        const event = await (overrides.request ?? (async () => acceptanceEvent))();
        await deliver?.("tx" as never, event as never);
        return event as never;
      },
    },
    inbox: { enqueueInTransaction: async (transaction, key, event) => { enqueued.push({ transaction, key, event }); return {} as never; } },
    report: (role, error) => { reported.push({ role, error }); },
    ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
  };
  return { acceptance: new FactoryValidatorAcceptance(options), calls, enqueued, reported };
}

describe("the request-acceptance command", () => {
  test("records the candidate, schedules the missing validator, and lets the kernel wait", async () => {
    const { acceptance, calls, enqueued } = harness({ schedules: [schedule("a")], admit: async () => { throw new Coded("factory_compute_admission_not_admitted"); } });
    expect(await acceptance.command(service, reference)).toBeNull();
    expect(calls).toEqual(["candidate", "plan", "reserve:a", "admit:a"]);
    // The command never decides and never delivers: that is the role's.
    expect(enqueued).toEqual([]);
  });

  test("a refusal that waiting cannot fix still fails the command by name", async () => {
    const { acceptance } = harness({ record: async () => { throw new Coded("factory_release_trust_inactive"); } });
    await expect(acceptance.command(service, reference)).rejects.toMatchObject({ code: "factory_release_trust_inactive" });
  });
});

describe("advance", () => {
  test("a candidate with no missing claim is ready", async () => {
    expect(await harness().acceptance.advance(service, reference)).toEqual({ ready: true, progressed: false, terminal: true, unsettled: [] });
  });

  test("an admitted schedule is progress, and a reservation not yet admitted is progress only when it was new", async () => {
    const waiting = { ready: false, terminal: false, unsettled: [] };
    expect(await harness({ schedules: [schedule("a")] }).acceptance.advance(service, reference)).toEqual({ ...waiting, progressed: true });
    const notYet = async () => { throw new Coded("factory_compute_admission_not_admitted"); };
    expect(await harness({ schedules: [schedule("a")], admit: notYet, reserveCreated: true }).acceptance.advance(service, reference)).toEqual({ ...waiting, progressed: true });
    expect(await harness({ schedules: [schedule("a")], admit: notYet, reserveCreated: false }).acceptance.advance(service, reference)).toEqual({ ...waiting, progressed: false });
  });

  test("an admission failure that is not a wait is raised", async () => {
    const { acceptance } = harness({ schedules: [schedule("a")], admit: async () => { throw new Coded("factory_validator_schedule_stale"); } });
    await expect(acceptance.advance(service, reference)).rejects.toMatchObject({ code: "factory_validator_schedule_stale" });
  });

  test("a stored attempt is read, never re-reserved: terminal is ready, in flight waits", async () => {
    const both = harness({ schedules: [schedule("done"), schedule("running")], stored: { done: "delivered", running: "leased" }, terminal: ["done"] });
    expect(await both.acceptance.advance(service, reference)).toEqual({ ready: false, progressed: false, terminal: false, unsettled: [] });
    // The completed attempt's reservation is settled with its measured usage and terminal fact.
    expect(both.calls).toEqual(["candidate", "plan", "terminal:done", "settle:reservation-done:5/3/7:sha256:e", "terminal:running"]);
    const all = harness({ schedules: [schedule("done")], stored: { done: "delivered" }, terminal: ["done"] });
    expect(await all.acceptance.advance(service, reference)).toEqual({ ready: true, progressed: false, terminal: true, unsettled: [] });
  });

  test("an attempt that will never produce a terminal fact is unsettled, and uncertain only when its outcome is unknown", async () => {
    for (const [state, uncertain] of [["delivered", false], ["cancelled", false], ["dead_letter", false], ["outcome_unknown", true]] as const) {
      const { acceptance } = harness({ schedules: [schedule("gone")], stored: { gone: state } });
      expect(await acceptance.advance(service, reference)).toEqual({ ready: false, progressed: false, terminal: true, unsettled: [{ attemptId: "gone", reservationId: "reservation-gone", uncertain }] });
    }
  });

  test("one unsettled claim does not strand the others: every claim is visited, and a completed one still settles", async () => {
    const { acceptance, calls } = harness({ schedules: [schedule("gone"), schedule("done"), schedule("new")], stored: { gone: "dead_letter", done: "delivered" }, terminal: ["done"] });
    expect(await acceptance.advance(service, reference)).toEqual({ ready: false, progressed: true, terminal: false, unsettled: [{ attemptId: "gone", reservationId: "reservation-gone", uncertain: false }] });
    expect(calls).toEqual(["candidate", "plan", "terminal:gone", "terminal:done", "settle:reservation-done:5/3/7:sha256:e", "reserve:new", "admit:new"]);
  });
});

describe("deliver", () => {
  test("a ready command is decided and its event delivered in the decision's own transaction", async () => {
    const { acceptance, calls, enqueued } = harness();
    expect(await acceptance.deliver(service, reference)).toBe(true);
    expect(calls).toEqual(["candidate", "plan", "decide"]);
    expect(enqueued).toEqual([{ transaction: "tx", key: { projectId: "project-1", runId: "run-1", interpreterId: "interpreter-1" }, event: acceptanceEvent }]);
  });

  test("a failed or uncertain validator is answered with a typed failure, never a rejection and never a wait", async () => {
    for (const [state, error] of [["dead_letter", "factory_validator_attempt_failed"], ["outcome_unknown", "factory_validator_attempt_uncertain"]] as const) {
      const { acceptance, calls, enqueued } = harness({ schedules: [schedule("gone")], stored: { gone: state } });
      expect(await acceptance.deliver(service, reference)).toBe(true);
      expect(calls).not.toContain("decide");
      expect(calls).toContain("authority");
      // No usage was measured, so the hold is marked uncertain under the same name, never settled.
      expect(calls).toContain(`uncertain:reservation-gone:${error}`);
      expect(calls.some(call => call.startsWith("settle:"))).toBe(false);
      expect(enqueued).toEqual([{ transaction: "tx", key: { projectId: "project-1", runId: "run-1", interpreterId: "interpreter-1" }, event: {
        kind: "node-failed", id: `protected-acceptance-unsettled:${reference.commandId}`, atMs: 7, nodeId: "accept", commandId: reference.commandId,
        candidateGeneration: 0, attempt: 1, error, failureKind: "execution",
      } }]);
    }
  });

  test("with two claims, the failure waits for the other claim's terminal, then settles it and holds only the failed one", async () => {
    const live = harness({ schedules: [schedule("gone"), schedule("running")], stored: { gone: "dead_letter", running: "leased" } });
    expect(await live.acceptance.deliver(service, reference)).toBe(false);
    expect(live.enqueued).toEqual([]);
    expect(live.calls.some(call => call.startsWith("uncertain:"))).toBe(false);

    const done = harness({ schedules: [schedule("gone"), schedule("running")], stored: { gone: "dead_letter", running: "delivered" }, terminal: ["running"] });
    expect(await done.acceptance.deliver(service, reference)).toBe(true);
    expect(done.calls).toEqual(["candidate", "plan", "terminal:gone", "terminal:running", "settle:reservation-running:5/3/7:sha256:e", "authority", "uncertain:reservation-gone:factory_validator_attempt_failed"]);
    expect(done.enqueued).toHaveLength(1);
  });

  test("every unsettled claim is held, and an unknown outcome among them names the failure uncertain", async () => {
    const { acceptance, calls, enqueued } = harness({ schedules: [schedule("gone"), schedule("lost")], stored: { gone: "dead_letter", lost: "outcome_unknown" } });
    expect(await acceptance.deliver(service, reference)).toBe(true);
    expect(calls.filter(call => call.startsWith("uncertain:"))).toEqual(["uncertain:reservation-gone:factory_validator_attempt_uncertain", "uncertain:reservation-lost:factory_validator_attempt_uncertain"]);
    expect(enqueued).toMatchObject([{ event: { error: "factory_validator_attempt_uncertain", failureKind: "execution" } }]);
  });

  test("a command that is not ready is never decided", async () => {
    const { acceptance, calls, enqueued } = harness({ schedules: [schedule("a")], stored: { a: "leased" } });
    expect(await acceptance.deliver(service, reference)).toBe(false);
    expect(calls).not.toContain("decide");
    expect(enqueued).toEqual([]);
  });
});

describe("the validator-scheduling role", () => {
  const row = { project_id: "project-1", run_id: "run-1", interpreter_id: "interpreter-1", command_id: reference.commandId };

  test("delivers every pending command and reports progress", async () => {
    const { acceptance, enqueued } = harness({ pending: [row] });
    expect(await acceptance.driver().step(new AbortController().signal)).toBe(true);
    expect(enqueued).toHaveLength(1);
  });

  test("an empty scan is no work", async () => {
    expect(await harness().acceptance.driver().step(new AbortController().signal)).toBe(false);
  });

  test("a not-yet or a superseded command is skipped silently; every other failure is reported with its class", async () => {
    for (const quiet of ["factory_compute_admission_not_admitted", "factory_command_stale"]) {
      const { acceptance, reported } = harness({ pending: [row], record: async () => { throw new Coded(quiet); } });
      expect(await acceptance.driver().step(new AbortController().signal)).toBe(false);
      expect(reported).toEqual([]);
    }
    const trust = harness({ pending: [row], record: async () => { throw new Coded("factory_release_trust_revoked"); } });
    expect(await trust.acceptance.driver().step(new AbortController().signal)).toBe(false);
    expect(trust.reported.map(entry => entry.role)).toEqual([`validator-scheduling:trust:project-1/${reference.commandId}`]);
    const plain = harness({ pending: [row], record: async () => { throw new Error("connection reset"); } });
    await plain.acceptance.driver().step(new AbortController().signal);
    expect(plain.reported.map(entry => entry.role)).toEqual([`validator-scheduling:infrastructure:project-1/${reference.commandId}`]);
  });

  test("an aborted pass stops before the next command", async () => {
    const controller = new AbortController();
    controller.abort();
    const { acceptance, calls } = harness({ pending: [row, row] });
    expect(await acceptance.driver().step(controller.signal)).toBe(false);
    expect(calls).toEqual(["scan"]);
  });

  test("the scan is bounded and scoped to this tenant", async () => {
    expect(FACTORY_VALIDATOR_ACCEPTANCE_SCAN_LIMIT).toBe(16);
    expect(() => harness({ limit: 0 })).toThrow("factory_validator_acceptance_invalid");
    const database = { transaction: async () => undefined, execute: async () => ({ rows: [] }) } as unknown as TransactionalDb;
    expect(() => new FactoryValidatorAcceptance({ ...({} as FactoryValidatorAcceptanceOptions), database, tenantId, service: { subject: "orchestration", tenantId: "other" } })).toThrow("factory_validator_acceptance_scope");
  });
});

describe("an installation with no validator composed", () => {
  test("refuses the acceptance command by name at once", async () => {
    const refuse = factoryValidatorAcceptanceRefusal("factory_validator_none_declared", "nothing declared");
    const failure = await refuse(service, reference).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FactoryValidatorAcceptanceError);
    expect(failure).toMatchObject({ code: "factory_validator_none_declared", detail: "nothing declared", message: "factory_validator_none_declared: nothing declared" });
  });
});
