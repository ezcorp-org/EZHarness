import { describe, expect, test } from "bun:test";
import type { TransactionalDb } from "../db/migrations/types";
import {
  composeFactoryValidators,
  FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT,
  FactoryValidatorCompositionError,
  FactoryValidatorMaterialRegistration,
  factoryTrustedValidatorsFromDeclaration,
  factoryValidatorAwareSettlement,
  factoryValidatorResourcePolicy,
} from "./validator-composition";
import type { FactoryTrustedValidators } from "./validator-materials";
import type { FactoryProtectedValidatorSchedule } from "./validator-scheduler";

class Coded extends Error { constructor(readonly code: string) { super(code); } }

const reference = { tenantId: "tenant-1", projectId: "project-1", logicalRunId: "run-1", interpreterId: "interpreter-1", commandId: "factory-validator-attempt:abc" };
const service = { subject: "orchestration", tenantId: "tenant-1" };

describe("the gateway from the declaration", () => {
  const runtime = (name: string) => ({ name, runtime: { brokerAudience: name } as never });

  test("builds once from every declared runtime", () => {
    const built: unknown[] = [];
    const gateway = {} as FactoryTrustedValidators;
    expect(factoryTrustedValidatorsFromDeclaration((runtimes) => { built.push(runtimes); return gateway; }, [runtime("a"), runtime("b")])).toBe(gateway);
    expect(built).toEqual([[{ brokerAudience: "a" }, { brokerAudience: "b" }]]);
  });

  test("names the one runtime W05 refuses, or every runtime when only the set is refused", () => {
    const refuseB = (runtimes: readonly { brokerAudience: string }[]) => {
      if (runtimes.some(entry => entry.brokerAudience === "b")) throw new Coded("factory_validator_runtime_invalid");
      return {} as FactoryTrustedValidators;
    };
    expect(() => factoryTrustedValidatorsFromDeclaration(refuseB as never, [runtime("a"), runtime("b")]))
      .toThrow("factory_validator_runtime_rejected: b: factory_validator_runtime_invalid");
    const refuseSet = (runtimes: readonly unknown[]) => { if (runtimes.length > 1) throw new Error("duplicate runner"); return {} as FactoryTrustedValidators; };
    const error = (() => { try { factoryTrustedValidatorsFromDeclaration(refuseSet as never, [runtime("a"), runtime("b")]); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(FactoryValidatorCompositionError);
    expect((error as Error).message).toBe("factory_validator_runtime_rejected: a,b: duplicate runner");
  });
});

describe("the validator resource policy", () => {
  const allocations = { cpu: { resources: { cpu: 1 }, memoryBytes: 64, budget: { costMicros: "10", tokens: 5, computeMs: 100 } } };
  const initiator = { kind: "user", id: "owner", authentication: "session" };
  function policy(authorized: string[] = []) {
    return factoryValidatorResourcePolicy({
      lifecycle: { readExecutionPlanInTransaction: async () => ({ initiator, fence: { grantRevision: 7 } }) as never },
      grants: { authorizeInTransaction: async (_tx, principal, projectId, action, revision) => { authorized.push(`${(principal as { id: string }).id}:${projectId}:${action}:${revision}`); return {} as never; } },
      allocations,
    });
  }
  const scheduled = (resources: Record<string, unknown>) => ({ reference, schedule: { runtime: { validatorId: "claim", resources } } as unknown as FactoryProtectedValidatorSchedule });

  test("checks the initiator's live factory.run grant, then answers from the runtime's class", async () => {
    const authorized: string[] = [];
    expect(await policy(authorized).resolveInTransaction("tx" as never, scheduled({ resourceClass: "cpu", memoryBytes: 32, maxComputeMs: 4, maxTokens: 2, maxCostMicros: "3" }) as never))
      .toEqual({ envelopeId: "root", amount: { costMicros: "3", tokens: 2, computeMs: 4 }, resources: { cpu: 1 }, memoryBytes: 32 });
    expect(authorized).toEqual(["owner:project-1:factory.run:7"]);
  });

  test("a runtime that names no bounds takes the allocation, on the default class", async () => {
    expect(await policy().resolveInTransaction("tx" as never, scheduled({}) as never))
      .toEqual({ envelopeId: "root", amount: allocations.cpu.budget, resources: { cpu: 1 }, memoryBytes: 64 });
  });

  test("an undeclared class and every bound above the allocation refuse by name", async () => {
    await expect(policy().resolveInTransaction("tx" as never, scheduled({ resourceClass: "gpu" }) as never)).rejects.toMatchObject({ code: "factory_validator_resource_class_unknown" });
    await expect(policy().resolveInTransaction("tx" as never, scheduled({ resourceClass: "toString" }) as never)).rejects.toMatchObject({ code: "factory_validator_resource_class_unknown" });
    for (const excess of [{ memoryBytes: 65 }, { maxCostMicros: "11" }, { maxTokens: 6 }, { maxComputeMs: 101 }]) {
      await expect(policy().resolveInTransaction("tx" as never, scheduled(excess) as never)).rejects.toMatchObject({ code: "factory_validator_resource_denied" });
    }
  });
});

describe("the settlement router", () => {
  function router(lookup: () => Promise<unknown>) {
    const calls: string[] = [];
    const seam = (name: string) => async () => { calls.push(name); return name as never; };
    const routed = factoryValidatorAwareSettlement(
      { readBoundAttemptInTransaction: lookup as never },
      { completeInTransaction: seam("validator.complete"), readInTransaction: seam("validator.read"), recordInTransaction: seam("validator.record"), readOutcomeInTransaction: seam("validator.readOutcome") },
      { completions: { completeInTransaction: seam("task.complete"), readInTransaction: seam("task.read") }, outcomes: { recordInTransaction: seam("task.record"), readInTransaction: seam("task.readOutcome") } },
    );
    return { routed, calls };
  }
  async function drive(routed: ReturnType<typeof router>["routed"]) {
    await routed.completions.completeInTransaction("tx" as never, service, reference, {} as never);
    await routed.completions.readInTransaction("tx" as never, service, reference);
    await routed.outcomes.recordInTransaction("tx" as never, service, reference, {} as never);
    await routed.outcomes.readInTransaction("tx" as never, service, reference);
  }

  test("an attempt with a durable validator assignment settles as a validator", async () => {
    const { routed, calls } = router(async () => ({ candidate: {}, validatorIds: ["claim"] }));
    await drive(routed);
    expect(calls).toEqual(["validator.complete", "validator.read", "validator.record", "validator.readOutcome"]);
  });

  test("an attempt with no assignment settles through the task path", async () => {
    const { routed, calls } = router(async () => { throw new Coded("factory_validator_assignment_missing"); });
    await drive(routed);
    expect(calls).toEqual(["task.complete", "task.read", "task.record", "task.readOutcome"]);
  });

  test("any other lookup failure is raised rather than guessed", async () => {
    const { routed, calls } = router(async () => { throw new Coded("factory_validator_assignment_corrupt"); });
    await expect(routed.completions.completeInTransaction("tx" as never, service, reference, {} as never)).rejects.toMatchObject({ code: "factory_validator_assignment_corrupt" });
    await expect(routed.outcomes.readInTransaction("tx" as never, service, reference)).rejects.toThrow("factory_validator_assignment_corrupt");
    expect(calls).toEqual([]);
  });
});

describe("material registration", () => {
  /** A database that answers the version scan from a list, paging by the keyset the scan sends. */
  function database(versions: readonly string[]) {
    const scans: number[] = [];
    let page = 0;
    const db = {
      execute: async () => {
        const size = FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT;
        const slice = versions.slice(page * size, page * size + size);
        scans.push(slice.length);
        page = slice.length < size ? 0 : page + 1;
        return { rows: slice.map(name => ({ project_id: "project-1", factory_id: name, version: "1.0.0" })) };
      },
      transaction: async (work: (transaction: unknown) => Promise<unknown>) => work("tx"),
    } as unknown as TransactionalDb;
    return { db, scans };
  }
  function registration(versions: readonly string[], register: (factoryId: string) => Promise<void>, read: (factoryId: string) => Promise<void> = async () => {}) {
    const reported: string[] = [];
    const { db, scans } = database(versions);
    const registrar = new FactoryValidatorMaterialRegistration(db, "tenant-1",
      { readPublishedInTransaction: async (_tx, key) => { await read(key.factoryId); return { compiled: { factoryId: key.factoryId } } as never; } },
      { registerMaterialInTransaction: async (_tx, _project, compiled) => { await register((compiled as unknown as { factoryId: string }).factoryId); return {} as never; } },
      (role) => { reported.push(role); });
    return { registrar, reported, scans };
  }

  test("every version is registered once per process, across pages, and a repeat pass does nothing", async () => {
    const versions = Array.from({ length: FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT + 3 }, (_, index) => `factory-${String(index).padStart(2, "0")}`);
    const registered: string[] = [];
    const { registrar, reported, scans } = registration(versions, async (id) => { registered.push(id); });
    await registrar.registerAll(new AbortController().signal);
    expect(registered).toEqual(versions);
    expect(scans).toEqual([FACTORY_VALIDATOR_REGISTRATION_SCAN_LIMIT, 3]);
    expect(await registrar.step(new AbortController().signal)).toBe(false);
    expect(registered).toHaveLength(versions.length);
    expect(reported).toEqual([]);
  });

  test("a named refusal is reported once; an unprotected version is not a refusal; a transient failure retries", async () => {
    let flaky = 0;
    const { registrar, reported } = registration(["plain", "undeclared", "flaky"], async (id) => {
      if (id === "plain") throw new Coded("factory_validator_material_unprotected");
      if (id === "undeclared") throw new Coded("factory_validator_runtime_untrusted");
    }, async (id) => { if (id === "flaky" && flaky++ === 0) throw new Error("connection reset"); });
    expect(await registrar.step(new AbortController().signal)).toBe(false);
    expect(reported).toEqual(["validator-materials:factory_validator_runtime_untrusted:project-1/undeclared@1.0.0", "validator-materials:failed:project-1/flaky@1.0.0"]);
    // The next pass retries only the transient one, and it registers.
    expect(await registrar.step(new AbortController().signal)).toBe(true);
    expect(reported).toHaveLength(2);
  });

  test("an aborted pass stops between versions", async () => {
    const controller = new AbortController();
    const registered: string[] = [];
    const { registrar } = registration(["one", "two"], async (id) => { registered.push(id); controller.abort(); });
    await registrar.registerAll(controller.signal);
    expect(registered).toEqual(["one"]);
  });

  test("the scan bound is validated", () => {
    expect(() => new FactoryValidatorMaterialRegistration({} as TransactionalDb, "tenant-1", {} as never, {} as never, () => {}, 0)).toThrow("factory_validator_registration_invalid");
  });
});

describe("the composition", () => {
  test("refuses by name without the compute ledger and the task settlement stores", () => {
    const stores = { authority: {}, budgets: {}, journal: {}, queue: {}, inbox: {} };
    expect(() => composeFactoryValidators({ database: {} as TransactionalDb, config: { tenantId: "tenant-1" } as never, application: {} as never, stores: stores as never, service, validators: {} as never, allocations: {}, assurance: {} as never, releases: {} as never, report: () => {} }))
      .toThrow("factory_validator_stores_missing");
  });
});
