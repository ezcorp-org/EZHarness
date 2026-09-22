import { describe, expect, test } from "bun:test";
import type { TransactionalDb } from "../db/migrations/types";
import { FACTORY_VALIDATOR_ACCEPTANCE_SCAN_LIMIT, FactoryValidatorAcceptance, FactoryValidatorAcceptanceError, type FactoryValidatorAcceptanceOptions } from "./validator-acceptance";
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
  const options: FactoryValidatorAcceptanceOptions = {
    database, tenantId, service,
    scheduler: {
      planInTransaction: async () => { calls.push("plan"); return overrides.schedules ?? []; },
      reserveInTransaction: async (_tx, _service, _reference, value) => { calls.push(`reserve:${value.attemptId}`); return { created: overrides.reserveCreated ?? true }; },
      admitInTransaction: async (_tx, _service, _reference, value) => { calls.push(`admit:${value.attemptId}`); return (overrides.admit ?? (async () => ({})))(value.attemptId) as never; },
    },
    dispatch: { readInTransaction: async (_tx, _service, value) => { calls.push(`terminal:${value.commandId}`); return (overrides.terminal ?? []).includes(value.commandId) ? {} as never : undefined; } },
    queue: {
      readInTransaction: async (_tx, _project, attemptId) => {
        const state = overrides.stored?.[attemptId];
        return state === undefined || state === null ? null : { state } as never;
      },
    },
    effects: {
      recordCurrentCandidate: async () => { calls.push("candidate"); return (overrides.record ?? (async () => ({})))() as never; },
      requestAcceptance: async () => { calls.push("decide"); return (overrides.request ?? (async () => acceptanceEvent))() as never; },
    },
    inbox: { enqueue: async (key, event) => { enqueued.push({ key, event }); return {} as never; } },
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
    expect(await harness().acceptance.advance(service, reference)).toEqual({ ready: true, progressed: false });
  });

  test("an admitted schedule is progress, and a reservation not yet admitted is progress only when it was new", async () => {
    expect(await harness({ schedules: [schedule("a")] }).acceptance.advance(service, reference)).toEqual({ ready: false, progressed: true });
    const notYet = async () => { throw new Coded("factory_compute_admission_not_admitted"); };
    expect(await harness({ schedules: [schedule("a")], admit: notYet, reserveCreated: true }).acceptance.advance(service, reference)).toEqual({ ready: false, progressed: true });
    expect(await harness({ schedules: [schedule("a")], admit: notYet, reserveCreated: false }).acceptance.advance(service, reference)).toEqual({ ready: false, progressed: false });
  });

  test("an admission failure that is not a wait is raised", async () => {
    const { acceptance } = harness({ schedules: [schedule("a")], admit: async () => { throw new Coded("factory_validator_schedule_stale"); } });
    await expect(acceptance.advance(service, reference)).rejects.toMatchObject({ code: "factory_validator_schedule_stale" });
  });

  test("a stored attempt is read, never re-reserved: terminal is ready, in flight waits", async () => {
    const both = harness({ schedules: [schedule("done"), schedule("running")], stored: { done: "delivered", running: "leased" }, terminal: ["done"] });
    expect(await both.acceptance.advance(service, reference)).toEqual({ ready: false, progressed: false });
    expect(both.calls).toEqual(["candidate", "plan", "terminal:done", "terminal:running"]);
    const all = harness({ schedules: [schedule("done")], stored: { done: "delivered" }, terminal: ["done"] });
    expect(await all.acceptance.advance(service, reference)).toEqual({ ready: true, progressed: false });
  });

  test("an attempt that will never produce a terminal fact is named", async () => {
    for (const state of ["cancelled", "dead_letter", "outcome_unknown"]) {
      const { acceptance } = harness({ schedules: [schedule("gone")], stored: { gone: state } });
      const failure = await acceptance.advance(service, reference).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FactoryValidatorAcceptanceError);
      expect(failure).toMatchObject({ code: "factory_validator_attempt_unsettled", attemptId: "gone" });
    }
  });
});

describe("deliver", () => {
  test("a ready command is decided through requestAcceptance and delivered through the inbox", async () => {
    const { acceptance, calls, enqueued } = harness();
    expect(await acceptance.deliver(service, reference)).toBe(true);
    expect(calls).toEqual(["candidate", "plan", "decide"]);
    expect(enqueued).toEqual([{ key: { projectId: "project-1", runId: "run-1", interpreterId: "interpreter-1" }, event: acceptanceEvent }]);
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
