import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The installation's human bootstrap (C01, C12 step 7).
 *
 * One row per installation, written in two acts by two different requests:
 *
 *   - `redeemed`: first-run setup accepted the provisioned invitation and
 *     created the first administrator. That is identity, not consent.
 *   - `consented`: that same human, in a session, explicitly consented and
 *     received the bootstrap project's approve, trust, and release grants.
 *     The row, the grants, and the audit entry commit in ONE transaction.
 *
 * The CHECK makes a consented row without its project, digest, and time
 * unrepresentable, and the foreign keys make it name a real administrator and
 * a real factory project of this tenant.
 *
 * `factory_installation_purge_approvals` holds the other human act the
 * provisioner depends on: an administrator, in a session, approving the
 * permanent deletion of this installation's data. The operator's provisioner
 * reads it from the retained database at purge time; it cannot write one.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_installation_bootstrap (
    installation_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    invitation_id TEXT NOT NULL,
    admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('redeemed', 'consented')),
    project_id TEXT,
    consent_digest TEXT CHECK (consent_digest ~ '^sha256:[0-9a-f]{64}$'),
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consented_at TIMESTAMPTZ,
    CONSTRAINT factory_installation_bootstrap_consent_check CHECK ((state = 'consented') = (project_id IS NOT NULL AND consent_digest IS NOT NULL AND consented_at IS NOT NULL)),
    CONSTRAINT factory_installation_bootstrap_project_fkey FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_installation_purge_approvals (
    approval_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    approved_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 256),
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT factory_installation_purge_approvals_expiry_check CHECK (expires_at > approved_at)
  )`);
}
