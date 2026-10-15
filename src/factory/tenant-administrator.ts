import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryGrantError, type FactoryPrincipal } from "./grants";

/** Why a caller is not a tenant administrator for a human-only action, or null when it is. */
export type FactoryTenantAdministratorRefusal = "factory_human_required" | "factory_forbidden";

/**
 * One rule for every tenant-level administrator action: an `admin` user whose
 * status is exactly `active`. Anything else, a missing row or a NULL or unknown
 * status included, fails closed.
 */
export function isActiveFactoryAdministrator(user: { readonly role: string | null; readonly status: string | null } | undefined): boolean {
  return user?.role === "admin" && user.status === "active";
}

/**
 * A human interactive session of an active tenant administrator, read under a
 * share lock so a demotion commits either before or after the action, never
 * during it. Returns the refusal; each caller raises it in its own error family.
 */
export async function factoryTenantAdministratorRefusalInTransaction(transaction: MigrationDb, principal: FactoryPrincipal): Promise<FactoryTenantAdministratorRefusal | null> {
  if (principal.kind !== "user" || principal.authentication !== "session") return "factory_human_required";
  const [user] = rows<{ role: string | null; status: string | null }>(await transaction.execute(sql`SELECT role, status FROM users WHERE id=${principal.id} FOR SHARE`));
  return isActiveFactoryAdministrator(user) ? null : "factory_forbidden";
}

/** The tenant-level gate: the path names this installation's tenant, and the caller passes the rule above. */
export async function assertFactoryTenantAdministratorInTransaction(transaction: MigrationDb, installationTenantId: string, tenantId: string, principal: FactoryPrincipal): Promise<void> {
  if (tenantId !== installationTenantId) throw new FactoryGrantError("factory_forbidden");
  const refusal = await factoryTenantAdministratorRefusalInTransaction(transaction, principal);
  if (refusal) throw new FactoryGrantError(refusal);
}
