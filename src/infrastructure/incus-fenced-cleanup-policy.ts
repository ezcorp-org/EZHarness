import { sql, type SQLWrapper } from "drizzle-orm";
import { sandboxOperations } from "../db/schema";

/** A signed admission freezes only the original receipt linked to the current
 * tombstoned cleanup. The historical row continues to say OUTCOME_UNKNOWN. */
/** A signed retained-delete cutoff permits only the ordinary linked cleanup
 * that preserves the original START and FAILED DELETE evidence. */
function retainedCleanupContinuation(requireSucceeded = false) {
  return sql`EXISTS (
    SELECT 1 FROM incus_retained_destroy_noeffect_recoveries proof
    JOIN sandbox_cleanup_recoveries continuation ON continuation.failed_destroy_operation_id = proof.operation_id
    LEFT JOIN provider_sandbox_operations next ON next.id = continuation.destroy_operation_id
    WHERE proof.operation_id = cleanup.id AND proof.origin_operation_id = r.operation_id
      AND proof.origin_receipt_sha256 = r.receipt_sha256
      AND proof.original_operation->>'state' = 'OUTCOME_UNKNOWN'
      AND proof.original_operation->>'payloadHash' = cleanup.payload_hash
      AND proof.receipt->'payload'->>'operationId' = cleanup.id
      AND cleanup.state = 'FAILED' AND cleanup.error_code = 'OPERATOR_PROVEN_NO_EFFECT'
      AND cleanup.provider_operation_id IS NULL
      AND continuation.binding_id = b.id AND continuation.generation = r.generation
      AND continuation.installation_id = b.provider_installation_id
      AND continuation.release_id = b.provider_release_id AND continuation.connection_id = b.connection_id
      AND continuation.connection_revision = b.connection_revision
      AND continuation.provider_generation = r.provider_generation
      AND b.current_operation_id IN (continuation.stop_operation_id, continuation.destroy_operation_id)
      AND ${requireSucceeded ? sql`continuation.state = 'COMPLETED' AND next.state = 'SUCCEEDED' AND b.current_operation_id = next.id AND next.binding_id = b.id AND next.generation = r.generation AND next.kind = 'DESTROY'` : sql`TRUE`}
  )`;
}

export function fencedCleanupPredicate(operation: { id: SQLWrapper; bindingId: SQLWrapper; generation: SQLWrapper; state: SQLWrapper; payloadHash: SQLWrapper; providerOperationId: SQLWrapper }, requireCurrentCleanup = true) {
  return sql`EXISTS (
  SELECT 1 FROM incus_fenced_cleanup_recoveries r
  JOIN sandbox_bindings b ON b.id = r.binding_id
  JOIN provider_sandbox_operations cleanup ON cleanup.id = r.cleanup_operation_id
  WHERE r.operation_id = ${operation.id}
    AND r.binding_id = ${operation.bindingId}
    AND r.generation = ${operation.generation}
    AND ${requireCurrentCleanup ? sql`b.generation = r.generation AND (b.current_operation_id = cleanup.id OR ${retainedCleanupContinuation()}) AND b.tombstoned_at IS NOT NULL AND b.desired_state = 'ABSENT'` : sql`TRUE`}
    AND cleanup.binding_id = b.id AND cleanup.generation = r.generation
    AND cleanup.kind = 'DESTROY' AND cleanup.idempotency_scope = 'incus-qualification'
    AND cleanup.idempotency_key = r.fixture_operation_id || ':destroy'
    AND cleanup.request_payload->>'expectedGeneration' = r.provider_generation::text
    AND ${operation.state} = 'OUTCOME_UNKNOWN'
    AND r.original_operation->>'state' = 'OUTCOME_UNKNOWN'
    AND r.original_operation->>'payloadHash' = ${operation.payloadHash}
    AND r.original_operation->>'providerOperationId' = ${operation.providerOperationId}
)`;
}
export const fencedCleanupOriginal = fencedCleanupPredicate(sandboxOperations);
export const frozenFencedCleanupOriginal = fencedCleanupPredicate(sandboxOperations, false);

/** Drain excludes historical uncertainty only after ordinary cleanup proved
 * absence and released both reservations. Admission alone never drains it. */
export function compensatedCleanupPredicate(operation: Parameters<typeof fencedCleanupPredicate>[0]) {
  return sql`((${fencedCleanupPredicate(operation)}) AND EXISTS (
  SELECT 1 FROM incus_fenced_cleanup_recoveries r
  JOIN provider_sandbox_operations cleanup ON cleanup.id = r.cleanup_operation_id
  JOIN sandbox_bindings b ON b.id = r.binding_id
  JOIN sandbox_reservations reservation ON reservation.binding_id = b.id
  WHERE r.operation_id = ${operation.id}
    AND (cleanup.state = 'SUCCEEDED' OR ${retainedCleanupContinuation(true)}) AND b.observed_state = 'ABSENT'
    AND b.cleanup_confirmed_at IS NOT NULL
    AND reservation.generation = r.generation
    AND reservation.compute_state = 'RELEASED' AND reservation.disk_state = 'RELEASED'
    AND reservation.cleanup_intent_id = 'incus-qualification-destroy-' || r.fixture_operation_id
))`;

}
export const compensatedCleanupOriginal = compensatedCleanupPredicate(sandboxOperations);
