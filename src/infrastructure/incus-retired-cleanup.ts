import type { SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection";
import { sandboxOperations, type SandboxBinding } from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { ProviderRpcBroker } from "./provider-rpc-broker";
import { ProviderConnectionStore } from "./provider-connections/store";

/** This path runs reviewed host transport code; it never starts a release worker. */
export async function callRetiredIncusCleanup(
  db: Database,
  binding: SandboxBinding,
  operation: SandboxProtocolOperation,
  input: Record<string, unknown>,
  brokerFactory?: (store: ProviderConnectionStore, digest: string) => ProviderRpcBroker,
): Promise<unknown> {
  if (!["lifecycle.inspect", "lifecycle.destroy", "lifecycle.inspectOperation"].includes(operation)) {
    throw new Error("Retired Incus action is unavailable");
  }
  if (!binding.connectionRevision || binding.resourceKey !== binding.id || binding.cleanupConfirmedAt
    || input.sandboxId !== binding.id || input.connectionId !== binding.connectionId
    || input.providerId !== "incus") {
    throw new Error("Retired Incus binding is unavailable");
  }
  if (operation === "lifecycle.inspect" && (binding.tombstonedAt || binding.observedState !== "STOPPED")) {
    throw new Error("Retired Incus binding is unavailable");
  }
  if (operation !== "lifecycle.inspect") {
    const [journal] = binding.currentOperationId ? await db.select().from(sandboxOperations)
      .where(eq(sandboxOperations.id, binding.currentOperationId)).limit(1) : [];
    if (!journal || journal.bindingId !== binding.id || journal.kind !== "DESTROY"
      || journal.generation !== binding.generation || !["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(journal.state)
      || operation === "lifecycle.destroy" && (journal.state !== "DISPATCHING"
        || input.requestId !== journal.id || input.idempotencyKey !== journal.id
        || input.expectedGeneration !== journal.requestPayload.expectedGeneration)
      || operation === "lifecycle.inspectOperation" && input.operationId !== journal.providerOperationId) {
      throw new Error("Retired Incus journal is unavailable");
    }
  }
  const store = new ProviderConnectionStore(db);
  const { installation, release } = await store.loadRetiredRelease(binding.providerInstallationId, binding.providerReleaseId);
  const broker = brokerFactory?.(store, release.releaseDigest) ?? new ProviderRpcBroker({
    getMetadata: id => store.getMetadata(id),
    resolveForHost: scope => store.resolveRetiredForHost(scope, release.releaseDigest),
  }, undefined, db);
  const snapshot = { installation, release, limits: {} } as ActiveExtensionRelease;
  const scope = await broker.prepareAction(snapshot, binding.id, operation, input);
  if (scope.revision !== binding.connectionRevision || scope.connectionId !== binding.connectionId
    || scope.releaseId !== binding.providerReleaseId || scope.installationId !== binding.providerInstallationId) {
    throw new Error("Retired Incus connection changed");
  }
  const reply = await broker.request(scope, { command: scope.expectedCommand }, Number(input.rpcDeadlineMs));
  if (reply && typeof reply === "object" && "ok" in reply && reply.ok === true && "result" in reply) {
    return reply.result;
  }
  const error = reply && typeof reply === "object" && "error" in reply ? reply.error as { effect?: string; operationId?: string } : null;
  if (error?.effect === "unknown") {
    return { ok: false, error: { code: "OUTCOME_UNKNOWN", message: "The Incus mutation outcome is unknown",
      retryable: false, ...(error.operationId ? { operationId: error.operationId } : {}) } };
  }
  throw new Error("Retired Incus transport failed");
}
