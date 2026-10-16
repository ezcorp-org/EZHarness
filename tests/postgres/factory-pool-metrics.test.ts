import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { POOL_LEASE_STATES, POOL_RESOURCE_CLASSES } from "../../src/factory/pool/ledger";
import { PoolAdmissionService, type PoolPrincipal } from "../../src/factory/pool/service";
import { factoryMetricRenderer } from "../../src/factory/observability/metric-registry";
import { collectFactoryPoolMetrics } from "../../src/factory/observability/pool-metrics";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

let client: SQL; let close: () => Promise<void>; let service: PoolAdmissionService;
const tenant = (tenantId: string): PoolPrincipal => ({ kind: "tenant", tenantId, subject: tenantId, scopes: [`pool:tenant:${tenantId}`, `pool:grant:${tenantId}:grant-a`] });
const request = (tenantId: string, reservationId: string, resources: Record<string, number> = { cpu: 1 }) => service.request(tenant(tenantId), { reservationId, grantRevision: 1, grantScope: `${tenantId}:grant-a`, resources, admissionDeadline: new Date(Date.now() + 60_000).toISOString() });

beforeAll(async () => {
  ({ client, close } = await setupFactoryPoolPostgres());
  service = new PoolAdmissionService(client);
  await service.setup();
  await service.ledger.configureCapacity("cpu", 2);
  await service.ledger.configureCapacity("memory", 100);
}, 60_000);
afterAll(async () => { await close(); });

test("pool requests by state and resource class, and holds by registered tenant, every series present (C11 M3)", async () => {
  await request("tenant-01", "held-1");
  await request("tenant-01", "held-2", { cpu: 1, memory: 10 });
  await request("tenant-02", "queued-1");
  const registered = ["tenant-01", "tenant-02", "tenant-03"];
  const samples = await collectFactoryPoolMetrics(client, registered);
  const value = (name: string, labels: Record<string, string>) => samples.find((sample) => sample.name === name && JSON.stringify(sample.labels) === JSON.stringify(labels))?.value;

  expect(samples.filter((sample) => sample.name === "factory_pool_requests")).toHaveLength(POOL_LEASE_STATES.length * POOL_RESOURCE_CLASSES.length);
  expect(value("factory_pool_requests", { state: "held", resource_class: "cpu" })).toBe(2);
  expect(value("factory_pool_requests", { state: "held", resource_class: "memory" })).toBe(1);
  expect(value("factory_pool_requests", { state: "queued", resource_class: "cpu" })).toBe(1);
  expect(value("factory_pool_requests", { state: "running", resource_class: "gpu-host" })).toBe(0);
  expect(value("factory_pool_tenant_holds", { tenant: "tenant-01" })).toBe(2);
  expect(value("factory_pool_tenant_holds", { tenant: "tenant-02" })).toBe(0);
  expect(value("factory_pool_tenant_holds", { tenant: "tenant-03" })).toBe(0);

  const text = factoryMetricRenderer("pool", { strict: true }).render(samples, { tenant: registered });
  expect(text).not.toContain("held-1");
  // A tenant holding capacity that this pool's configuration does not register is dropped, never labelled.
  const unregistered = await collectFactoryPoolMetrics(client, ["tenant-02"]);
  expect(unregistered.some((sample) => sample.labels?.tenant === "tenant-01")).toBe(false);
});
