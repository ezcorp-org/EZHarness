import { assertJson } from "@ezcorp/extension-contract";
import { digestObject } from "./blobs";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "revoked";

/** Immutable facts that a human reviews and that a later effect must revalidate. */
export interface ApprovalContext {
  readonly subjectId: string;
  readonly subjectDigest: string;
  readonly principalId: string;
  readonly scope: string;
  readonly grants: readonly string[];
  readonly expectedGeneration: number;
  readonly expiresAtMs?: number;
}

export class ApprovalContextError extends Error {
  constructor(readonly code: "approval_context_invalid" | "approval_stale" | "approval_not_consumable") { super(code); this.name = "ApprovalContextError"; }
}

function text(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) throw new ApprovalContextError("approval_context_invalid");
}

/** Canonical, bounded approval facts shared by v4 activation and factory release. */
export function canonicalApprovalContext(context: ApprovalContext): ApprovalContext {
  text(context.subjectId); text(context.subjectDigest); text(context.principalId); text(context.scope);
  if (!Number.isSafeInteger(context.expectedGeneration) || context.expectedGeneration < 0 || (context.expiresAtMs !== undefined && (!Number.isSafeInteger(context.expiresAtMs) || context.expiresAtMs < 0))) throw new ApprovalContextError("approval_context_invalid");
  const grants: readonly string[] = context.grants;
  try { assertJson([...grants]); } catch { throw new ApprovalContextError("approval_context_invalid"); }
  if (grants.length > 1_000 || grants.some(grant => typeof grant !== "string" || grant.length === 0 || grant.length > 1_024)) throw new ApprovalContextError("approval_context_invalid");
  return { ...context, grants: [...new Set(grants)].sort() };
}

export function approvalContextDigest(context: ApprovalContext): string {
  return digestObject(canonicalApprovalContext(context));
}

export function assertApprovalUsable(status: ApprovalStatus, context: ApprovalContext, current: Pick<ApprovalContext, "subjectDigest" | "principalId" | "scope" | "expectedGeneration">, now: number, requireApproved: boolean): void {
  const expected = canonicalApprovalContext(context);
  if ((!requireApproved && status !== "pending") || (requireApproved && status !== "approved") || (expected.expiresAtMs !== undefined && expected.expiresAtMs <= now) || expected.subjectDigest !== current.subjectDigest || expected.principalId !== current.principalId || expected.scope !== current.scope || expected.expectedGeneration !== current.expectedGeneration) throw new ApprovalContextError("approval_stale");
}

/** State mutation is deliberately separate from persistence; callers still perform their locked CAS. */
export function consumeApproval(status: ApprovalStatus): "consumed" {
  if (status !== "approved") throw new ApprovalContextError("approval_not_consumable");
  return "consumed";
}
