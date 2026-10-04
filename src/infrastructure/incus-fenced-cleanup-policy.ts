import { sql, type SQLWrapper } from "drizzle-orm";
import { sandboxOperations } from "../db/schema";

/** A signed admission freezes only the original receipt linked to the current
 * tombstoned cleanup. The historical row continues to say OUTCOME_UNKNOWN. */
export function fencedCleanupPredicate(operation: { id: SQLWrapper; bindingId: SQLWrapper; generation: SQLWrapper; state: SQLWrapper; payloadHash: SQLWrapper; providerOperationId: SQLWrapper }, requireCurrentCleanup = true) {
  return sql`EXISTS (
  SELECT 1 FROM incus_fenced_cleanup_recoveries r
  JOIN sandbox_bindings b ON b.id = r.binding_id
  JOIN provider_sandbox_operations cleanup ON cleanup.id = r.cleanup_operation_id
  WHERE r.operation_id = ${operation.id}
    AND r.binding_id = ${operation.bindingId}
    AND r.generation = ${operation.generation}
    AND ${requireCurrentCleanup ? sql`b.generation = r.generation AND b.current_operation_id = cleanup.id AND b.tombstoned_at IS NOT NULL AND b.desired_state = 'ABSENT'` : sql`TRUE`}
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
  return sql`(${fencedCleanupPredicate(operation)}) AND EXISTS (
  SELECT 1 FROM incus_fenced_cleanup_recoveries r
  JOIN provider_sandbox_operations cleanup ON cleanup.id = r.cleanup_operation_id
  JOIN sandbox_bindings b ON b.id = r.binding_id
  JOIN sandbox_reservations reservation ON reservation.binding_id = b.id
  WHERE r.operation_id = ${operation.id}
    AND cleanup.state = 'SUCCEEDED' AND b.observed_state = 'ABSENT'
    AND b.cleanup_confirmed_at IS NOT NULL
    AND reservation.generation = r.generation
    AND reservation.compute_state = 'RELEASED' AND reservation.disk_state = 'RELEASED'
    AND reservation.cleanup_intent_id = 'incus-qualification-destroy-' || r.fixture_operation_id
)`;

}
export const compensatedCleanupOriginal = compensatedCleanupPredicate(sandboxOperations);
