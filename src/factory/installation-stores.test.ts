import { describe, expect, test } from "bun:test";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { createFactoryApplication } from "./application";
import { FactoryArtifacts } from "./artifacts";
import { FactoryAttemptQueue } from "./attempt-queue";
import { FactoryTaskCompletions } from "./task-completions";
import { FactoryTaskOutcomes } from "./task-outcomes";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { FactoryUsageSettlements } from "./usage-settlement";
import { FactoryComputeAdmissions } from "./compute-admissions";
import type { PoolAdmissionClient } from "./pool/client";
import { factoryInstallationStores } from "./installation-stores";

const tenantId = "tenant-stores";

/**
 * A handle the store constructors can hold.
 *
 * Every class here keeps the database and validates its collaborators; none of
 * them queries at construction, which is exactly what these tests exercise —
 * the scope guards that refuse a mismatched tenant, journal, or queue.
 */
function database(): TransactionalDb {
  const execute = async () => [];
  return {
    execute,
    async transaction<Result>(work: (transaction: { execute: typeof execute }) => Promise<Result>): Promise<Result> { return work({ execute }); },
  } as unknown as TransactionalDb;
}

function blobs(): BlobStore {
  return { async put() { return "sha256-x"; }, async get() { return new Uint8Array(); } } as unknown as BlobStore;
}

function inputs(db: TransactionalDb, pool?: PoolAdmissionClient) {
  const store = blobs();
  const application = createFactoryApplication({
    database: db,
    tenantId,
    blobs: store,
    runOptions: { interpreterBuild: "build-1", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
    availableResourceClasses: ["cpu"],
  });
  return {
    database: db,
    tenantId,
    blobs: store,
    application,
    transitions: new FactoryTransitionArtifacts(new FactoryArtifacts(db, store, tenantId)),
    serviceSubject: "factory-private",
    ...(pool === undefined ? {} : { pool }),
  };
}

function poolClient(): PoolAdmissionClient {
  return {
    async request() { throw new Error("unused"); },
    async status() { throw new Error("unused"); },
    async acknowledgeStart() { throw new Error("unused"); },
    async renew() { throw new Error("unused"); },
    async cancel() { throw new Error("unused"); },
    async confirmStopped() { throw new Error("unused"); },
  } as unknown as PoolAdmissionClient;
}

describe("factoryInstallationStores", () => {
  test("builds the base set once and shares the application's own journal", () => {
    const db = database();
    const options = inputs(db);
    const stores = factoryInstallationStores(options);

    // The journal is the application's instance, not a second one. A second
    // journal built here with a different attempt authorizer would authorize an
    // attempt by one rule on the HTTP path and another in the background.
    expect(stores.journal).toBe(options.application.journal);
    expect(stores.budgets).toBe(options.application.runs.budgets);
    expect(stores.queue).toBeInstanceOf(FactoryAttemptQueue);
    expect(stores.settlements).toBeInstanceOf(FactoryUsageSettlements);
    expect(stores.authority.tenantId).toBe(tenantId);
    expect(stores.inbox.tenantId).toBe(tenantId);
    expect(stores.settlements.tenantId).toBe(tenantId);
    // `FactoryTaskOutcomes` refuses a queue that holds another database, so the
    // identity below is the guard the whole shared-store shape exists to keep.
    expect(stores.queue.transactionalDatabase).toBe(db);
    expect(stores.queue.tenantId).toBe(tenantId);
  });

  test("without a pool client the three compute-dependent stores are absent", () => {
    const stores = factoryInstallationStores(inputs(database()));
    expect(stores.compute).toBeUndefined();
    expect(stores.completions).toBeUndefined();
    expect(stores.outcomes).toBeUndefined();
    // The base set is unaffected: a factory with no reachable pool still
    // projects run transitions and settles children.
    expect(stores.projections).toBeDefined();
    expect(stores.children).toBeDefined();
  });

  test("with a pool client every compute-dependent store constructs and agrees on scope", () => {
    const db = database();
    const stores = factoryInstallationStores(inputs(db, poolClient()));
    expect(stores.compute).toBeInstanceOf(FactoryComputeAdmissions);
    expect(stores.completions).toBeInstanceOf(FactoryTaskCompletions);
    expect(stores.outcomes).toBeInstanceOf(FactoryTaskOutcomes);
    expect(stores.compute!.tenantId).toBe(tenantId);
    // Constructing at all is the assertion: both task stores throw
    // `factory_task_*_scope` unless the compute ledger, the queue, the inbox and
    // the journal all name this tenant and this database.
    expect(stores.queue.transactionalDatabase).toBe(db);
  });

  test("the returned set is frozen, so a caller cannot swap a store after the guards ran", () => {
    const stores = factoryInstallationStores(inputs(database(), poolClient()));
    expect(Object.isFrozen(stores)).toBe(true);
    expect(() => { (stores as { compute?: unknown }).compute = undefined; }).toThrow();
  });

  test("a mismatched service subject still scopes the command authority to this tenant", () => {
    const db = database();
    const stores = factoryInstallationStores({ ...inputs(db), serviceSubject: "another-service" });
    expect(stores.authority.tenantId).toBe(tenantId);
  });
});
