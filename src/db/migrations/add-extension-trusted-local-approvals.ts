/**
 * Trusted-local approvals — the persistence of `TrustedLocalRunner`'s
 * `approvalFor(phase, digest)` contract.
 *
 * `packages/@ezcorp/extension-runner/src/trusted-local.ts` refuses to build
 * or execute unless a live approval names the EXACT digest and phase, an
 * approver, an expiry, and every omitted control
 * (`TRUSTED_LOCAL_OMITTED_CONTROLS`). This table is that approval, written at
 * the two human acknowledgement points — the Build action (phase `build`,
 * the workspace's source digest) and "Approve exact release" (phase
 * `execute`, the release's artifact digest) — and deleted when the approval
 * is revoked or the installation is disabled/uninstalled.
 *
 * Keyed per installation, not just per digest, because an artifact digest is
 * content-derived: two installations built from identical source share one.
 * Revoking one must not silently revoke the other. The runner looks up by
 * `(phase, digest)` only and accepts any live row, hence the second index.
 *
 * Deliberately a table rather than fields on the lifecycle's approval /
 * operation records: those records are the lifecycle's state machine, this is
 * the runner's authorisation. One source of truth per contract, and the
 * runner never has to reach into lifecycle internals to answer "may I".
 *
 * Idempotent and additive. Applied from src/db/migrate.ts after
 * add-extension-releases.ts, whose installations table this references.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_trusted_local_approvals (
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('build', 'execute')),
    digest TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    omitted_controls TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, phase, digest)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS extension_trusted_local_approvals_digest ON extension_trusted_local_approvals(phase, digest)`);
}
