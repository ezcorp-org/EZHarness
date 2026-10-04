import { incusCpuLoadDiagnostic } from "$server/infrastructure/incus-live-limit-probe";
import { IncusStopRequiredError, IncusCleanupRecoveryUnavailableError } from "$server/infrastructure/incus-feature-service";
import { randomUUID } from "node:crypto";
import { json } from "@sveltejs/kit";
import { logger } from "$server/logger";
import { requireAdminSession } from "$server/auth/middleware";
import { incusHostLiveWitnessReady } from "$server/infrastructure/incus-host-live-witness";
import { beginDurableIncusLiveCases, IncusQualificationPreparationError, INCUS_PREPARATION_CAUSE_CODES } from "$server/infrastructure/incus-live-cases";
import { createIncusQualificationWitness } from "$server/infrastructure/incus-startup";
import { IncusQualificationFixtureService, IncusQualificationStore, IncusQualificationOperationUnsettledError,
  type IncusQualificationScope } from "$server/infrastructure/incus-qualification";
import type { RequestHandler } from "./$types";

const log = logger.child("api.incus.qualification");
const preservationReasons = new Set(["outcome_unsettled", "newer_intent", "authority_changed"]);
const preparationStages = new Set(["fixtures", "enforcement", "limit_loads", "guest_preparation", "restart_handoff"]);
const unsettledStates = new Set(["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function isIdentifier(value: unknown): value is string { return typeof value === "string" && identifier.test(value); }
type Action = "create" | "status" | "destroy" | "start" | "stop" | "qualify" | "recoverCleanup";
const fields = ["action", "installationId", "releaseId", "connectionId", "presetId", "operationId"];

function parse(value: unknown): { action: Action; scope: IncusQualificationScope; operationId: string; powerOperationId?: string; failedDestroyOperationId?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action !== "create" && input.action !== "status" && input.action !== "destroy"
    && input.action !== "start" && input.action !== "stop" && input.action !== "qualify" && input.action !== "recoverCleanup") return null;
  const power = input.action === "start" || input.action === "stop";
  const expected = power ? [...fields, "powerOperationId"] : input.action === "recoverCleanup" ? [...fields, "failedDestroyOperationId"] : fields;
  if (Object.keys(input).sort().join(",") !== [...expected].sort().join(",")) return null;
  for (const field of expected.slice(1)) if (!isIdentifier(input[field])) return null;
  if (power && (!isIdentifier(input.powerOperationId))) return null;
  return { action: input.action, operationId: input.operationId as string,
    powerOperationId: power ? input.powerOperationId as string : undefined,
    failedDestroyOperationId: input.action === "recoverCleanup" ? input.failedDestroyOperationId as string : undefined,
    scope: { installationId: input.installationId as string, releaseId: input.releaseId as string,
      connectionId: input.connectionId as string, presetId: input.presetId as string } };
}

function operationState(operation: Awaited<ReturnType<IncusQualificationFixtureService["create"]>>) {
  return { id: operation.id, kind: operation.kind, state: operation.state,
    generation: operation.generation, providerOperationId: operation.providerOperationId,
    errorCode: operation.errorCode, createdAt: operation.createdAt, updatedAt: operation.updatedAt };
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const admin = requireAdminSession(locals);
  if (admin instanceof Response) return admin;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ code: "forbidden", message: "The qualification action must come from this site." }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ code: "invalid_input", message: "Provide a JSON qualification action." }, { status: 400 });
  }
  const input = parse(await request.json().catch(() => null));
  if (!input) return json({ code: "invalid_input", message: "Provide exact qualification scope and operation ID." }, { status: 400 });
  try {
    if (input.action === "qualify") {
      if (!await incusHostLiveWitnessReady()) {
        return json({ code: "qualification_unavailable",
          message: "The host live qualification witness is incomplete." }, { status: 503 });
      }
      const selected = await new IncusQualificationStore().authorizeFixture(input.scope);
      const witness = await createIncusQualificationWitness(input.scope, input.operationId);
      const run = await beginDurableIncusLiveCases({ witness,
        composeFixtureImageRef: process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF },
      input.scope, selected.preset, { runId: input.operationId, nonce: randomUUID(),
        deadlineMs: Date.now() + 20 * 60_000 });
      return json({ run }, { status: 202 });
    }
    const service = new IncusQualificationFixtureService();
    if (input.action === "recoverCleanup") {
      const result = await service.recoverCleanup(input.scope, input.operationId, input.failedDestroyOperationId!);
      return json({ recovery: { id: result.recovery.id, state: result.recovery.state,
        failedDestroyOperationId: result.recovery.failedDestroyOperationId,
        stopOperationId: result.recovery.stopOperationId, destroyOperationId: result.recovery.destroyOperationId },
        operation: operationState(result.operation) }, { status: 202 });
    }
    if (input.action === "status") return json(await service.status(input.scope, input.operationId));
    const operation = input.action === "create" ? await service.create(input.scope, input.operationId)
      : input.action === "destroy" ? await service.destroy(input.scope, input.operationId)
        : await service.setPower(input.scope, input.operationId,
          input.action === "start" ? "running" : "stopped", input.powerOperationId!);
    return json({ operation: operationState(operation) }, { status: 202 });
  } catch (error) {
    if (error instanceof IncusQualificationOperationUnsettledError
      && isIdentifier(error.operationId) && preservationReasons.has(error.reason)
      && (unsettledStates.has(error.state) || error.state === "SUCCEEDED" && error.reason !== "outcome_unsettled")) {
      const operation = { id: error.operationId, state: error.state };
      const reason = error.reason;
      log.warn("Saved Incus qualification operation requires review", { action: input.action,
        installationId: input.scope.installationId, connectionId: input.scope.connectionId,
        operationId: operation.id, state: operation.state, reason });
      return json({ code: "qualification_operation_preserved", operation, reason,
        message: `Saved operation ${operation.id} is ${operation.state} and must be reviewed. Do not retry qualification or repeat the mutation. Check its saved status first.` },
      { status: 409 });
    }
    if (error instanceof IncusQualificationPreparationError && input.action === "qualify"
      && preparationStages.has(error.stage) && INCUS_PREPARATION_CAUSE_CODES.has(error.causeCode) && ["confirmed", "unverified"].includes(error.cleanup)) {
      const cpuLoad = incusCpuLoadDiagnostic(error.cpuLoad);
      const diagnostic = { stage: error.stage, cleanup: error.cleanup, causeCode: error.causeCode, ...(cpuLoad ? { cpuLoad } : {}) };
      log.warn("Incus qualification preparation failed", { runId: input.operationId, ...diagnostic });
      return json({ code: "qualification_preparation_failed", ...diagnostic,
        message: `Qualification failed during ${diagnostic.stage} (${diagnostic.causeCode}); cleanup ${diagnostic.cleanup}. Inspect the saved fixtures before starting another run.` }, { status: 409 });
    }
    if (error instanceof IncusStopRequiredError) return json({ code: "stop_required", message: "Stop this sandbox before disposal." }, { status: 409 });
    if (input.action === "recoverCleanup" || error instanceof IncusCleanupRecoveryUnavailableError) return json({ code: "cleanup_recovery_unavailable", message: "The saved cleanup needs review. Inspect its status." }, { status: 409 });
    return json({ code: "qualification_unavailable",
      message: "The Incus qualification fixture is unavailable for this scope. Check host logs and its saved status." }, { status: 409 });
  }
};
