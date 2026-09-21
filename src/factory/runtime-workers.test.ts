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
    projections: { projectPending: async () => ({ runs: [] }) },
    report: () => {},
    ...overrides,
  };
}

const driver = (worked = false) => ({ step: async () => worked });

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
      "child-settlement:W06",
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

  // The defect this replaces: the three seam-driven roles only ever called
  // hold(), so supplying the seam removed the hold and registered nothing. The
  // role vanished from both lists and never ran.
  test("a supplied seam REGISTERS its role, it does not merely lift the hold", () => {
    const set = registerFactoryRuntimeWorkers(collaborators({
      seams: factoryRuntimeSeams({
        physicalStopper: driver(), usageReconciler: driver(), notificationSender: driver(),
        childSettlement: driver(), releaseProviders: driver(),
      }),
    }));
    for (const role of ["stop-settlement", "usage-reconciliation", "notification-send", "child-settlement", "release-outcome"]) {
      expect(set.workers.names()).toContain(role);
      expect(set.held.map((held) => held.role)).not.toContain(role);
    }
    // Every role is accounted for exactly once, in exactly one list.
    expect(set.workers.names().length + set.held.length).toBe(FACTORY_WORKER_ROLES.length);
  });

  test("a seam-driven role runs its seam's bounded step", async () => {
    const seen: boolean[] = [];
    const set = registerFactoryRuntimeWorkers(collaborators({
      seams: factoryRuntimeSeams({
        physicalStopper: { step: async () => { seen.push(true); return true; } },
        usageReconciler: { step: async () => { seen.push(false); return false; } },
      }),
    }));
    expect(await set.workers.get("stop-settlement").runBatch(new AbortController().signal)).toBe("worked");
    expect(await set.workers.get("usage-reconciliation").runBatch(signal)).toBe("idle");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("a role whose own collaborator could not be built holds by name", () => {
    const set = registerFactoryRuntimeWorkers(collaborators({ compute: undefined, attempts: undefined, projections: undefined }));
    expect(set.workers.names()).toEqual([]);
    expect(set.held.map((held) => held.role)).toEqual([...FACTORY_WORKER_ROLES]);
    // W01b corrected the old reason: readiness is a database read, so the
    // missing piece is this installation's configuration for the remote
    // runtime, not a container runner in this process. W09b assembled the
    // role, so the reason now names what the assembly needs and could not get.
    expect(set.held.find((held) => held.role === "attempt-dispatch")!.reason).toContain("hostLaunch endpoint");
  });

  test("distinguishes the two reasons a release outcome can be held", () => {
    // No store, and no collaborators to build one from: the reason points at
    // the role that already reported the exact cause rather than guessing it.
    const withoutStore = registerFactoryRuntimeWorkers(collaborators());
    const missingStore = withoutStore.held.find((held) => held.role === "release-outcome")!.reason;
    expect(missingStore).toContain("release store itself");
    expect(missingStore).toContain("release-store role");

    // Once the store is there the reason must name the one thing still
    // missing, not repeat the collaborator list. The consent is no longer it:
    // W07b's `readConsentInTransaction` landed and the driver reads it. What
    // no production code builds is a provider to publish through.
    const reasons = [
      registerFactoryRuntimeWorkers(collaborators({ seams: releaseSeams() })),
      registerFactoryRuntimeWorkers(collaborators({ notificationInbox: { deliverNextAcrossProjects: async () => false } })),
    ].map((set) => set.held.find((held) => held.role === "release-outcome")!.reason);
    for (const reason of reasons) {
      expect(reason).toContain("FactoryReleaseProvider");
      expect(reason).toContain("no release destination");
      expect(reason).not.toContain("consent");
    }
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
      projections: { projectPending: async (options) => { passes.push(options); return { runs: [{ progress: { applied: 3 } }] }; } },
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
      projections: { projectPending: async (options) => { passes.push(options); return { runs: [{ progress: { applied: 0 } }] }; } },
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
    expect(set.workers.names().length + set.held.length).toBe(FACTORY_WORKER_ROLES.length);
  });
});

describe("an attempt whose outcome the product refused to record", () => {
  test("reports the cause rather than leaving an unknown outcome unexplained", async () => {
    const seen: Array<{ role: string; error: unknown }> = [];
    const cause = Object.assign(new Error("factory_task_outcome_stale"), { code: "factory_task_outcome_stale" });
    // One pass, so the assertion is about one report rather than about how many
    // times a bounded batch repeats it.
    const set = registerFactoryRuntimeWorkers(collaborators({
      attempts: { dispatchOne: async () => ({ kind: "outcome_unknown", attemptId: "attempt-1", cause }) },
      report: (role, error) => { seen.push({ role, error }); },
      tuning: { batch: 1 },
    }));
    // The pass DID work — an attempt moved — so it reports progress rather than
    // failing the role, and the cause reaches the operator's stream.
    expect(await set.workers.get("attempt-dispatch").runBatch(new AbortController().signal)).toBe("worked");
    expect(seen).toEqual([{ role: "attempt-dispatch:outcome-unknown:attempt-1", error: cause }]);
  });

  test("an unknown outcome with no cause still names the attempt", async () => {
    const seen: string[] = [];
    const set = registerFactoryRuntimeWorkers(collaborators({
      attempts: { dispatchOne: async () => ({ kind: "outcome_unknown" }) },
      report: (role) => { seen.push(role); },
      tuning: { batch: 1 },
    }));
    await set.workers.get("attempt-dispatch").runBatch(new AbortController().signal);
    expect(seen).toEqual(["attempt-dispatch:outcome-unknown:unknown"]);
  });

  test("an ordinary dispatch reports nothing", async () => {
    const seen: string[] = [];
    const set = registerFactoryRuntimeWorkers(collaborators({
      attempts: { dispatchOne: async () => ({ kind: "cancelled", attemptId: "attempt-2" }) },
      report: (role) => { seen.push(role); },
      tuning: { batch: 1 },
    }));
    expect(await set.workers.get("attempt-dispatch").runBatch(new AbortController().signal)).toBe("worked");
    expect(seen).toEqual([]);
  });
});
