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
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "../extensions/v4/types";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { createFactoryApplication } from "./application";
import { FactoryArtifacts } from "./artifacts";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { factoryInstallationStores } from "./installation-stores";
import { FactoryTaskStops } from "./task-stops";
import type { PoolAdmissionClient } from "./pool/client";
import type { FactoryStartupConfig } from "./startup-config";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { FactoryReleaseError, FactoryReleases, type FactoryClaimableRelease, type FactoryReleaseConsentResult, type FactoryReleaseOperation, type FactoryReleaseProvider } from "./releases";
import type { FactoryStoppableAttempt } from "./task-stops";
import type { FactoryUncertainHold } from "./budgets";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryPrincipal } from "./grants";
import {
  FACTORY_RELEASE_CONSENT_FAULT_REASONS,
  FACTORY_RELEASE_OUTCOME_TRANSIENT_CODES,
  FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES,
  FactoryReleaseConsentAbsentError,
  FactoryUnknownReleaseProviderError,
  FactoryUnresolvedHoldError,
  factoryReleaseOutcomeDisposition,
  factoryReleaseOutcomeDriver,
  factoryReleaseProviderResolver,
  factoryStopSettlementDisposition,
  factoryStopSettlementDriver,
  factoryUsageReconciliationDisposition,
  factoryUsageReconciliationDriver,
  composeFactorySettlement,
  loadFactoryStopHostKeys,
} from "./dispatch-composition";

const SERVICE: TrustedFactoryServiceIdentity = { subject: "tenant-a", tenantId: "tenant-01" };
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
      async stop(service: TrustedFactoryServiceIdentity, reference: unknown) { expect(service).toBe(SERVICE); settled.push(reference); return { state: "stopped" } as never; },
    } as never, SERVICE, () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    // Nothing derived: the reference is the scan's own.
    expect(settled).toEqual([{ attemptId: "a" }, { attemptId: "b" }]);
  });

  test("an uncertain receipt is backpressure with its reason, not a settled stop", async () => {
    // The row stays listed and a later pass retries it. Counting it as settled
    // is how a run can sit in `stopping` while every pass reports success.
    const reported: Array<{ role: string; error: unknown }> = [];
    const cause = new Error("the host did not answer inside the bounded window");
    const driver = factoryStopSettlementDriver(database(), {
      async listStoppableInTransaction() { return [stoppable("open")]; },
      async stop() { return { state: "uncertain", cause } as never; },
    } as never, SERVICE, (role, error) => { reported.push({ role, error }); });

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(reported).toEqual([{ role: "stop-settlement:transient:open", error: cause }]);
    // Deferred, not settled: the step reports no progress, which is what makes
    // the worker wait its idle delay instead of spinning on a row it cannot move.
    expect((driver as unknown as { progress: { scanned: number; settled: number; deferred: number; failed: number } }).progress)
      .toMatchObject({ scanned: 1, settled: 0, deferred: 1, failed: 0 });
  });

  test("an uncertain receipt with no cause still names the attempt", async () => {
    const reported: Array<{ role: string; error: unknown }> = [];
    const driver = factoryStopSettlementDriver(database(), {
      async listStoppableInTransaction() { return [stoppable("open")]; },
      async stop() { return { state: "uncertain" } as never; },
    } as never, SERVICE, (role, error) => { reported.push({ role, error }); });

    await driver.step(SIGNAL);
    expect(reported[0]!.role).toBe("stop-settlement:transient:open");
    expect(reported[0]!.error).toMatchObject({ code: "factory_task_stop_uncertain", attemptId: "open" });
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
        return { state: "stopped" } as never;
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
  const claimable = (operationId: string, projectId = "project-1", runId = "run-1"): FactoryClaimableRelease =>
    ({ operationId, projectId, runId }) as unknown as FactoryClaimableRelease;
  const INITIATOR: FactoryPrincipal = { kind: "user", id: "run-owner", authentication: "api-key" };
  const APPROVAL = Object.freeze({ kind: "approval", consent: Object.freeze({ kind: "approval", approvalId: "approval-1" }), approvedBy: "session-1", expiresAtMs: 4_000, expectedGeneration: 1 });
  const operation = (tenantId = "tenant-01") => ({ tenantId, operationId: "op-1", state: "pending", destination: { provider: "s3" } }) as unknown as FactoryReleaseOperation;

  /**
   * One release store whose consent reader answers what the test names, and
   * which records every call so "no claim" can be asserted as zero calls
   * rather than as an absent side effect.
   */
  function store(options: {
    readonly claimables?: (projectId: string) => readonly FactoryClaimableRelease[];
    readonly consent?: FactoryReleaseConsentResult | (() => never);
    readonly inspect?: FactoryReleaseOperation | null;
    readonly claim?: () => unknown;
  }) {
    const calls = { inspected: [] as string[], consents: [] as unknown[][], claims: [] as unknown[][], dispatches: [] as unknown[][] };
    const releases = {
      async listClaimableInTransaction(_t: MigrationDb, projectId: string, limit?: number) {
        return (options.claimables ?? ((p: string) => (p === "project-1" ? [claimable("op-1")] : [])))(projectId).map((item) => ({ ...item, ...(limit === undefined ? {} : {}) }));
      },
      async inspect(projectId: string, operationId: string) {
        calls.inspected.push(`${projectId}/${operationId}`);
        return options.inspect === undefined ? operation() : options.inspect;
      },
      async readConsentInTransaction(transaction: MigrationDb, requester: unknown, subject: unknown) {
        calls.consents.push([transaction, requester, subject]);
        if (typeof options.consent === "function") return options.consent();
        return options.consent ?? (APPROVAL as unknown as FactoryReleaseConsentResult);
      },
      async claim(requester: unknown, projectId: string, operationId: string, granted: unknown) {
        calls.claims.push([requester, projectId, operationId, granted]);
        return (options.claim ?? (() => ({ operationId, destination: { provider: "s3" } })))();
      },
      async dispatch(claim: unknown, chosen: unknown) { calls.dispatches.push([claim, chosen]); return {} as never; },
    };
    return { releases: releases as never, calls };
  }

  /** The run lifecycle, which answers the one principal a claim is made as. */
  const runs = (initiator: FactoryPrincipal = INITIATOR) => ({
    async readExecutionPlanInTransaction(transaction: MigrationDb, key: { projectId: string; runId: string }) {
      plans.push([transaction, key]);
      return { fence: {}, compiled: {}, initiator } as never;
    },
  }) as never;
  let plans: unknown[][] = [];
  beforeEach(() => { plans = []; });

  test("the consent it claims over is the one the reader returned, for the run's own initiator", async () => {
    const provider = { name: "s3" } as unknown as FactoryReleaseProvider;
    const { releases, calls } = store({});
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: provider }), () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    // Exactly one claim, and its consent is the reader's own value rather than
    // anything this composition chose.
    expect(calls.claims).toHaveLength(1);
    expect(calls.claims[0]![3]).toBe(APPROVAL.consent);
    expect(calls.claims[0]![0]).toBe(INITIATOR);
    expect(calls.claims[0]!.slice(1, 3)).toEqual(["project-1", "op-1"]);
    // One outcome, dispatched to the provider the persisted destination names.
    expect(calls.dispatches).toHaveLength(1);
    expect(calls.dispatches[0]![1]).toBe(provider);
    // The consent read is asked about the operation that was inspected, under
    // the initiator the lifecycle returned.
    expect(calls.inspected).toEqual(["project-1/op-1"]);
    expect(calls.consents[0]![1]).toBe(INITIATOR);
  });

  test("the initiator and the consent are read in ONE transaction", async () => {
    // Two workers that read consent in different transactions can disagree
    // about why a claim failed, which is the isolation W07b's answer fixes.
    const { releases, calls } = store({});
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    expect(plans).toHaveLength(1);
    expect(calls.consents).toHaveLength(1);
    expect(calls.consents[0]![0]).toBe(plans[0]![0]);
  });

  test("no consent leaves the operation untouched, and is named rather than failed", async () => {
    const reported: [string, unknown][] = [];
    const { releases, calls } = store({ consent: { kind: "none", reason: "no_consent" } });
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role, error) => { reported.push([role, error]); });

    // Not progress, so the worker idles instead of spinning on a page it
    // cannot move.
    expect(await driver.step(SIGNAL)).toBe(false);
    expect(calls.claims).toEqual([]);
    expect(calls.dispatches).toEqual([]);
    expect(reported.map(([role]) => role)).toEqual(["release-outcome:transient:op-1"]);
    expect(reported[0]![1]).toBeInstanceOf(FactoryReleaseConsentAbsentError);
    expect((reported[0]![1] as FactoryReleaseConsentAbsentError).reason).toBe("no_consent");
  });

  test("an ambiguous policy is untouched, named, and needs a person", async () => {
    const reported: [string, unknown][] = [];
    const { releases, calls } = store({ consent: { kind: "none", reason: "policy_ambiguous" } });
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role, error) => { reported.push([role, error]); });

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(calls.claims).toEqual([]);
    // Two human-created authorities over one operation clear only when an
    // operator revokes one, so this is the loud column.
    expect(reported.map(([role]) => role)).toEqual(["release-outcome:fault:op-1"]);
    expect((reported[0]![1] as FactoryReleaseConsentAbsentError).reason).toBe("policy_ambiguous");
  });

  test("every other absence is a not-yet, and a corrupt pairing is not", () => {
    for (const reason of ["no_consent", "approval_generation_stale", "approval_not_approved", "approval_expired", "policy_expired", "policy_revoked", "policy_exhausted", "operation_absent"] as const) {
      expect(factoryReleaseOutcomeDisposition(new FactoryReleaseConsentAbsentError(reason))).toBe("transient");
    }
    for (const reason of FACTORY_RELEASE_CONSENT_FAULT_REASONS) {
      expect(factoryReleaseOutcomeDisposition(new FactoryReleaseConsentAbsentError(reason))).toBe("fault");
    }
    // A claim the other worker won, and a run that ended, are contention.
    for (const code of FACTORY_RELEASE_OUTCOME_TRANSIENT_CODES) expect(factoryReleaseOutcomeDisposition(failure(code))).toBe("transient");
    expect(factoryReleaseOutcomeDisposition(failure("factory_release_corrupt"))).toBe("fault");
    expect(factoryReleaseOutcomeDisposition(new Error("unclassified"))).toBe("fault");
  });

  test("an operation that left the work list between the scan and the claim is not claimed", async () => {
    const reported: string[] = [];
    const { releases, calls } = store({ inspect: null });
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role) => { reported.push(role); });

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(calls.consents).toEqual([]);
    expect(calls.claims).toEqual([]);
    expect(reported).toEqual(["release-outcome:transient:op-1"]);
  });

  test("two drivers over the same claimable operation leave exactly one winner", async () => {
    // `listClaimableInTransaction` takes no row lock, so both list it. The
    // exclusion is the claim's own, and the loser must read as contention.
    let claimed = 0;
    const reported: string[] = [];
    const build = () => {
      const { releases, calls } = store({ claim: () => { if (claimed++ > 0) throw failure("factory_release_claim_lost"); return { operationId: "op-1", destination: { provider: "s3" } }; } });
      return { driver: factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role) => { reported.push(role); }), calls };
    };
    const first = build();
    const second = build();
    const outcomes = await Promise.all([first.driver.step(SIGNAL), second.driver.step(SIGNAL)]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(first.calls.dispatches.length + second.calls.dispatches.length).toBe(1);
    expect(reported).toEqual(["release-outcome:transient:op-1"]);
  });

  test("a failure between the read and the claim leaves nothing half done", async () => {
    // The read half mutates nothing, so the only mutating step is the claim's
    // own transaction: a claim that raises leaves no dispatch and no retry
    // inside the same pass.
    const reported: string[] = [];
    const { releases, calls } = store({ claim: () => { throw failure("factory_release_stale"); } });
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role) => { reported.push(role); });

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(calls.claims).toHaveLength(1);
    expect(calls.dispatches).toEqual([]);
    expect(reported).toEqual(["release-outcome:fault:op-1"]);
  });

  test("an operation from another tenant is refused by the reader and never claimed", async () => {
    // The scope check is W07's and runs before any row is read; what this
    // driver owes is that the refusal reaches the report and nothing is
    // claimed over it.
    const reported: [string, unknown][] = [];
    const scoped = new FactoryReleases(database(), "tenant-01", { tenantId: "tenant-01" } as never, { tenantId: "tenant-01" } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const { releases, calls } = store({ inspect: operation("tenant-99"), consent: () => { throw new FactoryReleaseError("factory_release_scope"); } });
    expect(scoped.tenantId).toBe("tenant-01");
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role, error) => { reported.push([role, error]); });

    expect(await driver.step(SIGNAL)).toBe(false);
    expect(calls.claims).toEqual([]);
    expect(reported.map(([role]) => role)).toEqual(["release-outcome:fault:op-1"]);
    expect((reported[0]![1] as { code?: string }).code).toBe("factory_release_scope");
  });

  test("stops at the first project with work, so one busy project cannot starve the rest", async () => {
    const scanned: string[] = [];
    const { releases } = store({ claimables: (projectId) => { scanned.push(projectId); return projectId === "project-2" ? [claimable("op-1", projectId)] : []; } });
    const driver = factoryReleaseOutcomeDriver(database(), releases, runs(), async () => ["project-1", "project-2", "project-3"], factoryReleaseProviderResolver({ s3: {} as never }), () => {});

    expect(await driver.step(SIGNAL)).toBe(true);
    expect(scanned).toEqual(["project-1", "project-2"]);
  });

  test("a tenant with nothing claimable is no work, and a failure is reported by operation", async () => {
    const { releases: quietStore } = store({ claimables: () => [] });
    const quiet = factoryReleaseOutcomeDriver(database(), quietStore, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), () => {});
    expect(await quiet.step(SIGNAL)).toBe(false);

    const reported: string[] = [];
    const limits: (number | undefined)[] = [];
    const bad = {
      async listClaimableInTransaction(_t: MigrationDb, _p: string, limit?: number) { limits.push(limit); return [claimable("op-bad")]; },
      async inspect() { return operation(); },
      async readConsentInTransaction() { return APPROVAL as unknown as FactoryReleaseConsentResult; },
      async claim() { throw failure("factory_release_conflict"); },
      async dispatch() { return {} as never; },
    } as never;
    const failing = factoryReleaseOutcomeDriver(database(), bad, runs(), async () => ["project-1"], factoryReleaseProviderResolver({ s3: {} as never }), (role) => { reported.push(role); }, 3);

    expect(await failing.step(SIGNAL)).toBe(false);
    expect(limits).toEqual([3]);
    expect(reported).toEqual(["release-outcome:fault:op-bad"]);
  });
});

describe("loadFactoryStopHostKeys", () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  async function keyFile(name: string, mode = 0o600): Promise<{ root: string; path: string; pem: string }> {
    const root = await mkdtemp(join(process.env.HOME!, ".w09b-hostkeys-"));
    roots.push(root);
    await chmod(root, 0o700);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const path = join(root, name);
    await writeFile(path, pem, { mode });
    await chmod(path, mode);
    return { root, path, pem };
  }

  test("reads each configured public key by value, keeping the host and key id", async () => {
    const first = await keyFile("host-a.pem");
    const second = await keyFile("host-b.pem");
    const keys = await loadFactoryStopHostKeys([
      { hostId: "host-a", hostKeyId: "key-1", publicKeyPath: first.path },
      { hostId: "host-b", hostKeyId: "key-2", publicKeyPath: second.path },
    ]);
    expect(keys.map((key) => key.hostId)).toEqual(["host-a", "host-b"]);
    expect(keys.map((key) => key.hostKeyId)).toEqual(["key-1", "key-2"]);
    expect(keys[0]!.publicKey).toBe(first.pem);
    // `FactoryTaskStops` calls `createPublicKey` on this text, so a key that is
    // not a key fails there by name rather than being skipped here.
    expect(String(keys[1]!.publicKey)).toContain("BEGIN PUBLIC KEY");
  });

  test("refuses an empty list, because a list that verifies nothing is not a list", async () => {
    await expect(loadFactoryStopHostKeys([])).rejects.toMatchObject({ code: "factory_stop_host_keys_missing" });
  });

  test("refuses a key file the private reader will not open", async () => {
    const loose = await keyFile("host-loose.pem", 0o644);
    await expect(loadFactoryStopHostKeys([{ hostId: "host-a", hostKeyId: "key-1", publicKeyPath: loose.path }])).rejects.toBeDefined();
  });

  test("refuses a key file that is not there", async () => {
    const present = await keyFile("host-present.pem");
    await expect(loadFactoryStopHostKeys([{ hostId: "host-a", hostKeyId: "key-1", publicKeyPath: join(present.root, "absent.pem") }])).rejects.toBeDefined();
  });
});

describe("composeFactorySettlement", () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  async function material(): Promise<{ root: string; tls: { caPath: string; certificatePath: string; privateKeyPath: string; serviceTokenPath: string }; publicKeyPath: string }> {
    const root = await mkdtemp(join(process.env.HOME!, ".w09b-settlement-"));
    roots.push(root);
    await chmod(root, 0o700);
    const certs = await certificates(roots, "tenant-a");
    const tls = {
      caPath: join(root, "ca.pem"),
      certificatePath: join(root, "client.pem"),
      privateKeyPath: join(root, "client.key"),
      serviceTokenPath: join(root, "token"),
    };
    await writeFile(tls.caPath, certs.ca, { mode: 0o600 });
    await writeFile(tls.certificatePath, certs.clientCert, { mode: 0o600 });
    await writeFile(tls.privateKeyPath, certs.clientKey, { mode: 0o600 });
    await writeFile(tls.serviceTokenPath, "unused-by-the-host-stop-route", { mode: 0o600 });
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPath = join(root, "host.pub");
    await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o600 });
    return { root, tls, publicKeyPath };
  }

  function settlementStores(db: TransactionalDb) {
    const blobs = { async put() { return "sha256-x"; }, async get() { return new Uint8Array(); } } as unknown as BlobStore;
    const application = createFactoryApplication({
      database: db,
      tenantId: "tenant-01",
      blobs,
      runOptions: { interpreterBuild: "build-1", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
      availableResourceClasses: ["cpu"],
    });
    const pool = {
      async request() { throw new Error("unused"); }, async status() { throw new Error("unused"); },
      async acknowledgeStart() { throw new Error("unused"); }, async renew() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); }, async confirmStopped() { throw new Error("unused"); },
    } as unknown as PoolAdmissionClient;
    const stores = factoryInstallationStores({
      database: db, tenantId: "tenant-01", blobs, application,
      transitions: new FactoryTransitionArtifacts(new FactoryArtifacts(db, blobs, "tenant-01")),
      serviceSubject: "tenant-a", pool,
    });
    return { stores: { ...stores, compute: stores.compute!, outcomes: stores.outcomes! }, pool };
  }

  function config(tls: Awaited<ReturnType<typeof material>>["tls"], publicKeyPath: string) {
    return {
      installationId: "installation-01", tenantId: "tenant-01", hostId: "host-01",
      hostLaunch: { baseUrl: "https://127.0.0.1:1", serverName: "localhost", attemptTokenSecretPath: "/unused", tls },
      hostStopKeys: [{ hostId: "host-01", hostKeyId: "key-1", publicKeyPath }],
    } as unknown as FactoryStartupConfig;
  }

  test("composes both roles over one FactoryTaskStops", async () => {
    const { tls, publicKeyPath } = await material();
    const db = database();
    const { stores, pool } = settlementStores(db);
    const reported: string[] = [];
    const composed = await composeFactorySettlement({
      database: db, config: config(tls, publicKeyPath), stores, pool,
      service: SERVICE, report: (role) => { reported.push(role); },
    });

    expect(composed.stops).toBeInstanceOf(FactoryTaskStops);
    // The reconciler reads its settlement scope through the stop store, which
    // is why one composition produces both and neither can be built alone.
    expect(typeof composed.stops.readSettlementScopeInTransaction).toBe("function");
    // Both scans are empty against this handle, so a pass finds no work and
    // reports nothing.
    expect(await composed.stopSettlement.step(SIGNAL)).toBe(false);
    expect(await composed.usageReconciliation.step(SIGNAL)).toBe(false);
    expect(reported).toEqual([]);
  });

  test("refuses without the host launch endpoint the stop service lives behind", async () => {
    const { tls, publicKeyPath } = await material();
    const db = database();
    const { stores, pool } = settlementStores(db);
    const { hostLaunch: _omitted, ...withoutTransport } = config(tls, publicKeyPath) as unknown as Record<string, unknown>;
    await expect(composeFactorySettlement({
      database: db, config: withoutTransport as unknown as FactoryStartupConfig, stores, pool,
      service: SERVICE, report: () => {},
    })).rejects.toMatchObject({ code: "factory_stop_transport_missing" });
  });

  test("refuses without a configured host public key, rather than verifying nothing", async () => {
    const { tls, publicKeyPath } = await material();
    const db = database();
    const { stores, pool } = settlementStores(db);
    const { hostStopKeys: _omitted, ...withoutKeys } = config(tls, publicKeyPath) as unknown as Record<string, unknown>;
    await expect(composeFactorySettlement({
      database: db, config: withoutKeys as unknown as FactoryStartupConfig, stores, pool,
      service: SERVICE, report: () => {},
    })).rejects.toMatchObject({ code: "factory_stop_host_keys_missing" });
  });
});
