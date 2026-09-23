import { eq } from "drizzle-orm";
import { getDb } from "../db/connection";
import { sandboxBindings, sandboxOperations } from "../db/schema";
import { getReleaseRuntime, ReleaseProcess, resolveActiveRelease } from "../extensions/release-process";
import { incusMethodName } from "../../extensions/incus-sandbox/manifest";
import type { SandboxProtocolOperation } from "@ezcorp/extension-contract";
import {
  IncusDispatchAuthorizationError,
  type HostAuthorizedIncusMethodCaller,
  type IncusDispatchScope,
} from "../sandboxes/incus-dispatcher";
import { callRetiredIncusCleanup } from "./incus-retired-cleanup";

/** Host-only method caller. A provider worker cannot supply this authority. */
export class IncusMethodCaller implements HostAuthorizedIncusMethodCaller {
  async call(scope: IncusDispatchScope, method: string, input: Record<string, unknown>): Promise<unknown> {
    const lifecycleOperations: SandboxProtocolOperation[] = [
      "lifecycle.create", "lifecycle.setPower", "lifecycle.destroy", "lifecycle.inspectOperation",
    ];
    const operation = lifecycleOperations.find(candidate => incusMethodName(candidate) === method);
    if (!operation) throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    const [binding, journal] = await Promise.all([
      getDb().select().from(sandboxBindings).where(eq(sandboxBindings.id, scope.bindingId)).limit(1),
      getDb().select().from(sandboxOperations).where(eq(sandboxOperations.id, scope.operationId)).limit(1),
    ]);
    const current = binding[0];
    const receipt = journal[0];
    if (!current || !receipt || receipt.bindingId !== scope.bindingId || receipt.generation !== scope.generation
      || current.projectId !== scope.projectId || current.providerInstallationId !== scope.installationId
      || current.providerReleaseId !== scope.releaseId || current.connectionId !== scope.connectionId
      || current.connectionRevision !== scope.connectionRevision || current.resourceKey !== scope.resourceKey
      || input.sandboxId !== scope.bindingId || input.connectionId !== scope.connectionId
      || input.rpcDeadlineMs !== scope.deadlineMs) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    if (operation !== "lifecycle.inspectOperation" &&
      (current.generation !== scope.generation || current.currentOperationId !== scope.operationId)) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    if (operation !== "lifecycle.inspectOperation" && receipt.state !== "DISPATCHING") {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    if (operation === "lifecycle.inspectOperation" && !["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(receipt.state)) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    const expectedKind = operation === "lifecycle.create" ? "CREATE"
      : operation === "lifecycle.destroy" ? "DESTROY"
        : operation === "lifecycle.setPower" ? input.desiredState === "running" ? "START" : "STOP"
          : receipt.kind;
    if (operation === "lifecycle.inspectOperation") {
      if (input.operationId !== receipt.providerOperationId) {
        throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
      }
    } else {
      if (receipt.kind !== expectedKind || input.requestId !== scope.operationId
        || input.idempotencyKey !== scope.operationId) {
        throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
      }
      if (operation === "lifecycle.create") {
        for (const field of ["profile", "presetId", "presetDigest", "effectiveSettingsDigest"] as const) {
          if (input[field] !== receipt.requestPayload[field] || input[field] !== current[field]) {
            throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
          }
        }
      } else if (input.expectedGeneration !== receipt.requestPayload.expectedGeneration) {
        throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
      }
    }
    let snapshot: Awaited<ReturnType<typeof resolveActiveRelease>> | null = null;
    try { snapshot = await resolveActiveRelease(scope.installationId, getReleaseRuntime()); }
    catch { /* A retained release is checked against its persisted approval below. */ }
    if (!snapshot || snapshot.release.id !== scope.releaseId) {
      if (receipt.kind !== "DESTROY" || !["lifecycle.destroy", "lifecycle.inspectOperation"].includes(operation)) {
        throw new IncusDispatchAuthorizationError("RELEASE_REVOKED");
      }
      return callRetiredIncusCleanup(getDb(), current, operation, input);
    }
    if (snapshot.installation.generation < 1) {
      throw new IncusDispatchAuthorizationError("RELEASE_CHANGED");
    }
    const runtime = getReleaseRuntime();
    const process = new ReleaseProcess(scope.installationId, runtime);
    try {
      const response = await process.callIncusSandboxOperation(scope.bindingId, operation, input);
      return response.result;
    } finally {
      // A lost reply may hide an admitted Incus effect. The controller keeps
      // those errors UNKNOWN until provider readback proves the outcome.
      process.kill();
      await process.whenCallsSettled();
    }
  }
}
