import { insertAuditEntry } from "../db/queries/audit-log";
import { findTrustedLocalApproval } from "../db/queries/extension-trusted-local-approvals";
import type { TrustedLocalHooks } from "./trusted-local-runner";

/**
 * The database-backed half of the trusted-local wiring: the approval store
 * `TrustedLocalRunner.authorize()` reads and the audit row it writes after
 * each grant. Kept apart from `trusted-local-runner.ts` so that module — and
 * `runner-connection.ts` above it — stays free of `db/` imports (the reason
 * is spelled out there). The lifecycle service loads this module lazily at
 * initialisation and hands the result to `configureTrustedLocalRunner`; the
 * integration test does the same with the same function, so there is one
 * definition of what the runner is told.
 */
export function createTrustedLocalHooks(): TrustedLocalHooks {
  return {
    approvalFor: (phase, digest) => findTrustedLocalApproval(phase, digest),
    audit: async ({ mode, approval }) => {
      await insertAuditEntry(approval.approvedBy, `extension.${mode.replace("-", "_")}.${approval.phase}`, approval.digest, { expiresAt: new Date(approval.expiresAt).toISOString(), omittedControls: approval.omittedControls });
    },
  };
}
