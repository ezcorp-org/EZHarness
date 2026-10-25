import type { Database } from "../../db/connection";
import { IncusQualificationCheckpointStore } from "../incus-qualification-checkpoint";
import { IncusQualificationFixtureService, IncusQualificationStore } from "../incus-qualification";
import { IncusLiveCleanupController } from "../incus-live-cleanup-controller";
import { reconcileIncusWithClaimedCleanup } from "../incus-startup";

/** The real startup consumers share one transaction-bound DB. Effects fail the fixture. */
export function completedCleanupComponents(db: Database, publicKey: string,
  onEffect: () => void = () => {}, now = Date.now()) {
  const denyEffect = async () => { onEffect(); throw new Error("unexpected provider or accounting effect"); };
  const checkpoints = new IncusQualificationCheckpointStore(db, publicKey);
  const controller = new IncusLiveCleanupController({ db, checkpoints,
    fixtures: new IncusQualificationFixtureService({ db }), qualifications: new IncusQualificationStore({ db }),
    readinessProjectId: "readiness", now: () => now,
    freshFeatureGate: () => ({ checkReadiness: denyEffect, reconcile: denyEffect, settleCompletedOperation: denyEffect }) });
  const reconcile = () => reconcileIncusWithClaimedCleanup({ checkpoints,
    recover: denyEffect,
    verifySettled: (scope, handle, operationId) => controller.settleAlreadyCompletedDestroy(scope, handle, operationId),
    reconcile: async () => {} });
  return { checkpoints, controller, reconcile };
}
