/**
 * The four role drivers.
 *
 * Each test asserts the same property from a different angle: the driver
 * settles only on a fact the owning package produced, and reports rather than
 * invents when it cannot. The usage driver is the sharpest case — settling a
 * hold the resolver could not resolve would put a number on work nobody
 * measured — so its "unknown" path is asserted twice, once for the refusal and
 * once for the disposition that keeps it retryable.
 */
import { describe, expect, test } from "bun:test";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryClaimableRelease, FactoryReleaseOperation, FactoryReleaseProvider } from "./releases";
import type { FactoryStoppableAttempt } from "./task-stops";
import type { FactoryUncertainHold } from "./budgets";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryPrincipal } from "./grants";
import {
  FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES,
  FactoryUnknownReleaseProviderError,
  FactoryUnresolvedHoldError,
  factoryReleaseOutcomeDriver,
  factoryReleaseProviderResolver,
  factoryStopSettlementDisposition,
  factoryStopSettlementDriver,
  factoryUsageReconciliationDisposition,
  factoryUsageReconciliationDriver,
} from "./dispatch-composition";

const SERVICE: TrustedFactoryServiceIdentity = { subject: "tenant-a", tenantId: "tenant-01" };
const REQUESTER: FactoryPrincipal = { kind: "service", id: "worker", authentication: "service" } as FactoryPrincipal;
const SIGNAL = new AbortController().signal;

function database(): TransactionalDb {
  const execute = async () => [];
  return { execute, async transaction<R>(work: (t: MigrationDb) => Promise<R>) { return work({ execute } as unknown as MigrationDb); } } as unknown as TransactionalDb;
}

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("the stop-settlement step", () => {
  const stoppable = (attemptId: string): FactoryStoppableAttempt =>
    ({ attemptId, reference: { attemptId }, reservationId: `res-${attemptId}` }) as unknown as FactoryStoppableAttempt;

  test("settles each listed cancellation against the reference the scan returned", async () => {
    const settled: unknown[] = [];
    const driver = factoryStopSettlementDriver(database(), {
      async listStoppableInTransaction() { return [stoppable("a"), stoppable("b")]; },
      async stop(service: TrustedFactoryServiceIdentity, reference: unknown) { expect(service).toBe(SERVICE); settled.push(reference); return {} as never; },
    } as never, SERVICE, () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    // Nothing derived: the reference is the scan's own.
    expect(settled).toEqual([{ attemptId: "a" }, { attemptId: "b" }]);
  });

  test("an empty list is no work", async () => {
    const driver = factoryStopSettlementDriver(database(), {
      async listStoppableInTransaction() { return []; },
      async stop() { throw new Error("nothing to settle"); },
    } as never, SERVICE, () => {});
    expect(await driver.step(SIGNAL)).toBe(false);
  });

  test("a conflict is contention here, where it is a fault for child settlement", () => {
    // This scan does not filter on terminal state, so two workers listing the
    // same row is expected and only one commits.
    expect(FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES).toEqual(["factory_task_stop_conflict", "factory_task_stop_not_found"]);
    expect(factoryStopSettlementDisposition(failure("factory_task_stop_conflict"))).toBe("transient");
    expect(factoryStopSettlementDisposition(failure("factory_task_stop_not_found"))).toBe("transient");
    expect(factoryStopSettlementDisposition(failure("factory_task_stop_corrupt"))).toBe("fault");
    // Unknown and unreadable inputs default to the loud answer.
    expect(factoryStopSettlementDisposition(failure("something_new"))).toBe("fault");
    expect(factoryStopSettlementDisposition(null)).toBe("fault");
  });

  test("names the disposition and the attempt in the report, and steps over both kinds", async () => {
    const reported: string[] = [];
    const driver = factoryStopSettlementDriver(database(), {
      async listStoppableInTransaction(_t: MigrationDb, options: { limit?: number }) { expect(options).toEqual({ limit: 5 }); return [stoppable("busy"), stoppable("bad"), stoppable("ok")]; },
      async stop(_s: unknown, reference: { attemptId: string }) {
        if (reference.attemptId === "busy") throw failure("factory_task_stop_conflict");
        if (reference.attemptId === "bad") throw failure("factory_task_stop_corrupt");
        return {} as never;
      },
    } as never, SERVICE, (role) => { reported.push(role); }, 5);

    expect(await driver.step(SIGNAL)).toBe(true);
    expect(reported).toEqual(["stop-settlement:transient:busy", "stop-settlement:fault:bad"]);
  });
});

describe("the usage-reconciliation step", () => {
  const hold = (reservationId: string): FactoryUncertainHold =>
    ({ reservationId, projectId: "project-1", runId: "run-1", envelopeId: "env-1", heldCostMicros: "100" }) as unknown as FactoryUncertainHold;

  test("settles only on the four facts the resolver produced", async () => {
    const settled: unknown[] = [];
    const driver = factoryUsageReconciliationDriver(database(), {
      async listUncertainWithCostInTransaction() { return [hold("res-1")]; },
    } as never, {
      async resolve() {
        return { kind: "resolved", reservationId: "res-1", attemptId: "attempt-1", operationId: "op-1", providerReceiptDigest: "sha256:receipt", usage: { costMicros: "42" } } as never;
      },
      async reconcile(input: unknown) { settled.push(input); return {} as never; },
    } as never, () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    // Every field is the resolver's; none is this file's.
    expect(settled).toEqual([{ reservationId: "res-1", attemptId: "attempt-1", operationId: "op-1", providerReceiptDigest: "sha256:receipt", usage: { costMicros: "42" } }]);
  });

  test("an unresolved hold is left uncertain, reported, and retried later", async () => {
    const reported: string[] = [];
    let reconciled = 0;
    const driver = factoryUsageReconciliationDriver(database(), {
      async listUncertainWithCostInTransaction() { return [hold("res-9")]; },
    } as never, {
      async resolve() { return { kind: "unknown", reservationId: "res-9", reason: "receipt-not-sealed" } as never; },
      async reconcile() { reconciled += 1; return {} as never; },
    } as never, (role) => { reported.push(role); });

    // No progress, and above all no settlement: a number here would be a cost
    // nobody measured.
    expect(await driver.step(SIGNAL)).toBe(false);
    expect(reconciled).toBe(0);
    expect(reported).toEqual(["usage-reconciliation:transient:res-9"]);
  });

  test("an unresolved hold is backpressure; anything else needs a person", () => {
    expect(factoryUsageReconciliationDisposition(new FactoryUnresolvedHoldError("receipt-not-sealed"))).toBe("transient");
    expect(factoryUsageReconciliationDisposition(failure("factory_budget_corrupt"))).toBe("fault");
    expect(factoryUsageReconciliationDisposition(null)).toBe("fault");
    expect(new FactoryUnresolvedHoldError("why").code).toBe("factory_usage_hold_unresolved");
  });

  test("an empty page is no work, and an explicit limit reaches the scan", async () => {
    const limits: unknown[] = [];
    const driver = factoryUsageReconciliationDriver(database(), {
      async listUncertainWithCostInTransaction(_t: MigrationDb, options: unknown) { limits.push(options); return []; },
    } as never, { async resolve() { return {} as never; }, async reconcile() { return {} as never; } } as never, () => {}, 7);

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(limits).toEqual([{ limit: 7 }]);
  });
});

describe("the release provider resolver", () => {
  const github = { name: "github" } as unknown as FactoryReleaseProvider;
  const s3 = { name: "s3" } as unknown as FactoryReleaseProvider;
  const operation = (provider: string) => ({ destination: { provider } }) as FactoryReleaseOperation;

  test("selects by the destination the operation already carries", () => {
    const resolver = factoryReleaseProviderResolver({ github, s3 });
    expect(resolver.resolve(operation("github"))).toBe(github);
    expect(resolver.resolve(operation("s3"))).toBe(s3);
  });

  test("an unknown provider is refused, never defaulted", () => {
    // Publishing to some other provider would put the release somewhere nobody
    // approved.
    const resolver = factoryReleaseProviderResolver({ github });
    expect(() => resolver.resolve(operation("gitlab"))).toThrow(FactoryUnknownReleaseProviderError);
    expect(() => resolver.resolve(operation("gitlab"))).toThrow("factory_release_provider_unknown: gitlab");
  });

  test("composing with no provider at all is refused", () => {
    expect(() => factoryReleaseProviderResolver({})).toThrow(FactoryUnknownReleaseProviderError);
  });
});

describe("the release-outcome step", () => {
  const claimable = (operationId: string, projectId = "project-1"): FactoryClaimableRelease =>
    ({ operationId, projectId }) as unknown as FactoryClaimableRelease;
  const consent = () => ({ kind: "policy", policyId: "policy-1", expectedRevision: 1 }) as never;

  test("claims and dispatches to the provider the claim's destination names", async () => {
    const provider = { name: "s3" } as unknown as FactoryReleaseProvider;
    const dispatched: unknown[] = [];
    const driver = factoryReleaseOutcomeDriver(database(), {
      async listClaimableInTransaction(_t: MigrationDb, projectId: string) { return projectId === "project-1" ? [claimable("op-1")] : []; },
      async claim() { return { operationId: "op-1", destination: { provider: "s3" } } as never; },
      async dispatch(claim: unknown, chosen: unknown) { dispatched.push([claim, chosen]); return {} as never; },
    } as never, async () => ["project-1"], factoryReleaseProviderResolver({ s3: provider }), REQUESTER, consent, () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    expect((dispatched[0] as unknown[])[1]).toBe(provider);
  });

  test("stops at the first project with work, so one busy project cannot starve the rest", async () => {
    const scanned: string[] = [];
    const driver = factoryReleaseOutcomeDriver(database(), {
      async listClaimableInTransaction(_t: MigrationDb, projectId: string) { scanned.push(projectId); return projectId === "project-2" ? [claimable("op-2", projectId)] : []; },
      async claim() { return { operationId: "op-2", destination: { provider: "s3" } } as never; },
      async dispatch() { return {} as never; },
    } as never, async () => ["project-1", "project-2", "project-3"], factoryReleaseProviderResolver({ s3: {} as never }), REQUESTER, consent, () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    expect(scanned).toEqual(["project-1", "project-2"]);
  });

  test("a tenant with nothing claimable is no work, and a failure is reported by operation", async () => {
    const quiet = factoryReleaseOutcomeDriver(database(), {
      async listClaimableInTransaction() { return []; },
      async claim() { throw new Error("nothing to claim"); },
      async dispatch() { return {} as never; },
    } as never, async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), REQUESTER, consent, () => {});
    expect(await quiet.step(SIGNAL)).toBe(false);

    const reported: string[] = [];
    const failing = factoryReleaseOutcomeDriver(database(), {
      async listClaimableInTransaction(_t: MigrationDb, _p: string, limit?: number) { expect(limit).toBe(3); return [claimable("op-bad")]; },
      async claim() { throw failure("factory_release_conflict"); },
      async dispatch() { return {} as never; },
    } as never, async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), REQUESTER, consent, (role) => { reported.push(role); }, 3);

    expect(await failing.step(SIGNAL)).toBe(false);
    expect(reported).toEqual(["release-outcome:fault:op-bad"]);
  });
});
