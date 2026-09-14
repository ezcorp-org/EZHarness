import { describe, expect, test } from "bun:test";
import { FACTORY_WORKER_ROLES, registerFactoryRuntimeWorkers, type FactoryRuntimeWorkerCollaborators } from "./runtime-workers";
import { factoryRuntimeSeams, FACTORY_RELEASE_SEAMS } from "./runtime-seams";

const signal = new AbortController().signal;

function collaborators(overrides: Partial<FactoryRuntimeWorkerCollaborators> = {}): FactoryRuntimeWorkerCollaborators {
  return {
    service: { subject: "factory-private", tenantId: "tenant-01" },
    seams: factoryRuntimeSeams(),
    compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
    attempts: { dispatchOne: async () => ({ kind: "idle" }) },
    projections: { projectPending: async () => ({ applied: 0 }) },
    report: () => {},
    ...overrides,
  };
}

function releaseSeams(): FactoryRuntimeWorkerCollaborators["seams"] {
  return factoryRuntimeSeams(Object.fromEntries(FACTORY_RELEASE_SEAMS.map((key) => [key, {}])));
}

describe("registerFactoryRuntimeWorkers", () => {
  test("registers the roles it can drive, in a start order that produces before it consumes", () => {
    const set = registerFactoryRuntimeWorkers(collaborators({
      notificationInbox: { deliverNextAcrossProjects: async () => false },
    }));
    expect(set.workers.names()).toEqual([
      "compute-admission-dispatch",
      "compute-admission-poll",
      "attempt-dispatch",
      "run-projection",
      "notification-inbox-delivery",
    ]);
    // Every registered name is one of the plan's roles.
    for (const name of set.workers.names()) expect(FACTORY_WORKER_ROLES).toContain(name as never);
  });

  test("holds a role it cannot drive and names the seam and the owning package", () => {
    const set = registerFactoryRuntimeWorkers(collaborators());
    expect(set.held.map((held) => `${held.role}:${held.workPackage}`)).toEqual([
      "notification-inbox-delivery:W07/W08",
      "child-settlement:W05",
      "release-outcome:W07/W08",
      "usage-reconciliation:W03",
      "notification-send:W17",
      "stop-settlement:W03",
    ]);
    for (const held of set.held) {
      expect(held.reason.length).toBeGreaterThan(20);
      expect(FACTORY_WORKER_ROLES).toContain(held.role as never);
    }
    // A held role is not registered as a loop, so nothing can drain a queue
    // into an answer no collaborator produced.
    for (const held of set.held) expect(set.workers.names()).not.toContain(held.role);
  });

  test("a supplied seam removes its hold", () => {
    const set = registerFactoryRuntimeWorkers(collaborators({
      seams: factoryRuntimeSeams({ physicalStopper: {}, usageReconciler: {}, notificationSender: {} }),
    }));
    const heldRoles = set.held.map((held) => held.role);
    expect(heldRoles).not.toContain("stop-settlement");
    expect(heldRoles).not.toContain("usage-reconciliation");
    expect(heldRoles).not.toContain("notification-send");
  });

  test("distinguishes the two reasons a release outcome can be held", () => {
    const withoutSeams = registerFactoryRuntimeWorkers(collaborators());
    expect(withoutSeams.held.find((held) => held.role === "release-outcome")!.reason).toContain("sender fence");

    const withSeams = registerFactoryRuntimeWorkers(collaborators({ seams: releaseSeams() }));
    expect(withSeams.held.find((held) => held.role === "release-outcome")!.reason).toContain("claimable-operation scan");
  });

  test("maps every non-idle compute status to progress and only idle to no work", async () => {
    for (const status of ["admitted", "queued", "busy", "rejected", "retry", "cancelled"]) {
      const set = registerFactoryRuntimeWorkers(collaborators({
        compute: { dispatchNext: async () => ({ status }), pollNext: async () => ({ status }) },
      }));
      expect(await set.workers.get("compute-admission-dispatch").runBatch(new AbortController().signal)).toBe("worked");
      expect(await set.workers.get("compute-admission-poll").runBatch(new AbortController().signal)).toBe("worked");
    }
    const idle = registerFactoryRuntimeWorkers(collaborators());
    expect(await idle.workers.get("compute-admission-dispatch").runBatch(signal)).toBe("idle");
    expect(await idle.workers.get("compute-admission-poll").runBatch(signal)).toBe("idle");
  });

  test("passes the service identity and the caller's signal to the compute driver", async () => {
    const seen: Array<{ subject: string; aborted: boolean }> = [];
    const controller = new AbortController();
    const set = registerFactoryRuntimeWorkers(collaborators({
      compute: {
        dispatchNext: async (service, probeSignal) => { seen.push({ subject: service.subject, aborted: probeSignal!.aborted }); return { status: "idle" }; },
        pollNext: async (service, probeSignal) => { seen.push({ subject: service.subject, aborted: probeSignal!.aborted }); return { status: "idle" }; },
      },
    }));
    await set.workers.get("compute-admission-dispatch").runBatch(controller.signal);
    await set.workers.get("compute-admission-poll").runBatch(controller.signal);
    expect(seen).toEqual([{ subject: "factory-private", aborted: false }, { subject: "factory-private", aborted: false }]);
  });

  test("treats a dispatched attempt as progress and an idle queue as none", async () => {
    const dispatched = registerFactoryRuntimeWorkers(collaborators({ attempts: { dispatchOne: async () => ({ kind: "completed" }) } }));
    expect(await dispatched.workers.get("attempt-dispatch").runBatch(new AbortController().signal)).toBe("worked");
    expect(await registerFactoryRuntimeWorkers(collaborators()).workers.get("attempt-dispatch").runBatch(signal)).toBe("idle");
  });

  test("bounds one projection pass and treats zero applied as no work", async () => {
    const passes: Array<{ runs?: number } | undefined> = [];
    const worked = registerFactoryRuntimeWorkers(collaborators({
      projections: { projectPending: async (options) => { passes.push(options); return { applied: 3 }; } },
      projectionRuns: 4,
      tuning: { batch: 3 },
    }));
    // A projector that always has work still yields at the batch bound, and
    // every pass carries the configured run bound.
    expect(await worked.workers.get("run-projection").runBatch(new AbortController().signal)).toBe("worked");
    expect(passes).toEqual([{ runs: 4 }, { runs: 4 }, { runs: 4 }]);

    const idle = registerFactoryRuntimeWorkers(collaborators());
    expect(await idle.workers.get("run-projection").runBatch(signal)).toBe("idle");
    await idle.workers.get("run-projection").runBatch(signal);
  });

  test("uses the default projection bound when the composition does not set one", async () => {
    const passes: Array<{ runs?: number } | undefined> = [];
    const set = registerFactoryRuntimeWorkers(collaborators({
      projections: { projectPending: async (options) => { passes.push(options); return { applied: 0 }; } },
    }));
    await set.workers.get("run-projection").runBatch(signal);
    expect(passes).toEqual([{ runs: 8 }]);
  });

  test("delivers the notification inbox and reports an empty inbox as no work", async () => {
    const delivered = registerFactoryRuntimeWorkers(collaborators({ notificationInbox: { deliverNextAcrossProjects: async () => true } }));
    expect(await delivered.workers.get("notification-inbox-delivery").runBatch(new AbortController().signal)).toBe("worked");
    const empty = registerFactoryRuntimeWorkers(collaborators({ notificationInbox: { deliverNextAcrossProjects: async () => false } }));
    expect(await empty.workers.get("notification-inbox-delivery").runBatch(signal)).toBe("idle");
  });

  test("routes a failed step to the report with its role name", async () => {
    const reported: Array<{ role: string; message: string }> = [];
    const set = registerFactoryRuntimeWorkers(collaborators({
      attempts: { dispatchOne: async () => { throw new Error("queue unavailable"); } },
      report: (role, error) => { reported.push({ role, message: String(error) }); },
    }));
    const worker = set.workers.get("attempt-dispatch");
    await expect(worker.runBatch(signal)).rejects.toThrow("queue unavailable");
    // The loop, not runBatch, is what reports; drive it once to prove the wiring.
    worker.start();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await worker.stop();
    expect(reported[0]).toMatchObject({ role: "attempt-dispatch" });
    expect(reported[0]!.message).toContain("queue unavailable");
  });

  test("applies the configured worker tuning to every registered role", () => {
    const set = registerFactoryRuntimeWorkers(collaborators({
      tuning: { batch: 2, idleDelayMs: 25, errorDelayMs: 50, maxErrorDelayMs: 100 },
    }));
    // The bound is observable: a driver that always works stops at two steps.
    expect(set.workers.names().length).toBeGreaterThan(0);
    const bounded = registerFactoryRuntimeWorkers(collaborators({
      tuning: { batch: 2 },
      attempts: { dispatchOne: async () => ({ kind: "completed" }) },
    }));
    return bounded.workers.get("attempt-dispatch").runBatch(new AbortController().signal).then((progress) => {
      expect(progress).toBe("worked");
      expect(bounded.workers.get("attempt-dispatch").state).toMatchObject({ worked: 2, saturated: 1 });
    });
  });

  test("the role list covers every role the plan names", () => {
    expect([...FACTORY_WORKER_ROLES]).toEqual([
      "compute-admission-dispatch",
      "compute-admission-poll",
      "attempt-dispatch",
      "run-projection",
      "notification-inbox-delivery",
      "child-settlement",
      "release-outcome",
      "usage-reconciliation",
      "notification-send",
      "stop-settlement",
    ]);
    const set = registerFactoryRuntimeWorkers(collaborators());
    const accounted = new Set([...set.workers.names(), ...set.held.map((held) => held.role)]);
    expect([...accounted].sort()).toEqual([...FACTORY_WORKER_ROLES].sort());
  });
});
