import { sql, type SQL } from "drizzle-orm";

/**
 * Opens release claims and attempt launches for a test whose subject is not
 * checkpoint freshness.
 *
 * C06 fails closed: with no policy row, a tenant with no sealed checkpoint
 * younger than fifteen minutes cannot claim an effect. A test of releases or
 * launches does not run the barrier, so it writes the one explicit opt-out
 * row instead. The installation must be bound first. The freshness rule
 * itself is tested in the recovery suites, which never call this.
 */
export async function openFactoryEffectClaimsForTest(database: { execute(query: SQL): Promise<unknown> }, tenantId: string): Promise<void> {
  await database.execute(sql`INSERT INTO factory_checkpoint_policy (tenant_id, enforce_freshness) VALUES (${tenantId}, FALSE)
    ON CONFLICT (tenant_id) DO UPDATE SET enforce_freshness = FALSE`);
}
