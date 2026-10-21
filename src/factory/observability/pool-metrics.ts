/**
 * The pool's metric samples, from its own ledger (C11 M3).
 *
 * Requests by state and resource class, and the capacity each registered
 * tenant holds. Every combination is present, zeros included, so a series
 * that empties reads 0. The tenant label carries only the tenants this pool's
 * own configuration registers; a holder outside that set is not labelled.
 */
import { POOL_LEASE_STATES, POOL_RESOURCE_CLASSES, poolRows as rows, type PoolSql } from "../pool/ledger";
import type { FactoryMetricSample } from "./metric-registry";

export async function collectFactoryPoolMetrics(database: PoolSql, registeredTenants: readonly string[]): Promise<FactoryMetricSample[]> {
  const requests = new Map(rows<{ state: string; resource_class: string; value: number | string }>(await database.unsafe(
    // The ledger stores the vector as a JSON text inside jsonb; `#>> '{}'` unwraps either form.
    "SELECT r.state, k AS resource_class, count(*) AS value FROM factory_pool_requests r, jsonb_object_keys((r.resources_json #>> '{}')::jsonb) k GROUP BY 1, 2",
  )).map((row) => [`${row.state}\0${row.resource_class}`, Number(row.value)]));
  const holds = new Map(rows<{ tenant_id: string; value: number | string }>(await database.unsafe(
    "SELECT tenant_id, count(*) AS value FROM factory_pool_requests WHERE state IN ('held','running') GROUP BY tenant_id",
  )).map((row) => [row.tenant_id, Number(row.value)]));
  return [
    ...POOL_LEASE_STATES.flatMap((state) => POOL_RESOURCE_CLASSES.map((resourceClass) => ({
      name: "factory_pool_requests", labels: { state, resource_class: resourceClass }, value: requests.get(`${state}\0${resourceClass}`) ?? 0,
    }))),
    ...registeredTenants.map((tenant) => ({ name: "factory_pool_tenant_holds", labels: { tenant }, value: holds.get(tenant) ?? 0 })),
  ];
}
