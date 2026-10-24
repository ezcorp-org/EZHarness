/**
 * C11 M4 (W4H-34): every factory service's /metrics, scraped over HTTP with the
 * scrape token, against real data. Every series must belong to a family that
 * service declares, carry only declared label values, stay within the family's
 * series bound, and hold no run, attempt or operation identifier and no secret,
 * even though the database holds all of them.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { makeFactoryTempPrivateRoot } from "../../src/__tests__/helpers/factory-private-root";
import {
  METRIC_BUILD, METRIC_TENANT, forceAttempt, forceBudget, forceCheckpoint, forceReadyWork, forceRelease, forceRun, forceSend, seedMetricInstallation,
} from "../../src/__tests__/helpers/factory-metric-conditions";
import { PoolAdmissionService, type PoolPrincipal } from "../../src/factory/pool/service";
import { FactoryMetricCounters, collectFactoryInstallationMetrics } from "../../src/factory/observability/installation-metrics";
import { FACTORY_METRIC_FAMILIES, FACTORY_METRIC_SERIES_MAX, FACTORY_METRIC_SERVICES, type FactoryMetricService } from "../../src/factory/observability/metric-registry";
import { serveFactoryMetrics, serveFactoryReadyMetrics, type FactoryMetricsListener } from "../../src/factory/observability/metrics-listener";
import { collectFactoryPoolMetrics } from "../../src/factory/observability/pool-metrics";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const TOKEN = "w4h-34-scrape-token-0123456789abcdef0123";
const SECRET_MARKER = "sk-live-W4H34-MARKER-not-a-label";
const IDENTIFIER_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|run-[0-9a-f]/i;

let root: string;
let product: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let pool: { client: SQL; close: () => Promise<void> };
const listeners = new Map<FactoryMetricService, FactoryMetricsListener>();

beforeAll(async () => {
  root = await makeFactoryTempPrivateRoot("w4h-34-scrape-");
  await chmod(root, 0o700);
  await writeFile(join(root, "token"), TOKEN, { mode: 0o600 });
  const endpoint = { hostname: "127.0.0.1", port: 0, scrapeTokenPath: join(root, "token") };

  product = await setupFactoryPostgres();
  const db = product.db as never;
  const now = Date.now();
  await seedMetricInstallation(db);
  // Every kind of row the collector reads, with identifiers and a secret in them.
  await forceReadyWork(db, now, 45_000, "runner_package_not_ready");
  const run = await forceRun(db, now, { status: "running", updatedAgeMs: 61_000, build: "interpreter-old" });
  await forceAttempt(db, now, run, "launched");
  await forceBudget(db, { exhausted: true, reservationState: "uncertain" });
  await forceRelease(db, now, "uncertain", 75_000);
  await forceCheckpoint(db, now, 1_000_000);
  await forceSend(db, now, "dead_letter", 1_000);
  await product.db.execute(sql`UPDATE factory_runs SET request_payload=${JSON.stringify({ secret: SECRET_MARKER })}`);
  const counters = new FactoryMetricCounters();
  counters.securityDenial("cross_tenant_broker");
  listeners.set("harness", await serveFactoryMetrics(endpoint, "harness", () => collectFactoryInstallationMetrics({ database: db, tenantId: METRIC_TENANT, interpreterBuild: METRIC_BUILD, counters })));

  pool = await setupFactoryPoolPostgres();
  const service = new PoolAdmissionService(pool.client);
  await service.setup();
  await service.ledger.configureCapacity("cpu", 4);
  const tenant: PoolPrincipal = { kind: "tenant", tenantId: "tenant-01", subject: "tenant-01", scopes: ["pool:tenant:tenant-01", "pool:grant:tenant-01:grant-a"] };
  await service.request(tenant, { reservationId: `reservation-${crypto.randomUUID()}`, grantRevision: 1, grantScope: "tenant-01:grant-a", resources: { cpu: 1 }, admissionDeadline: new Date(Date.now() + 60_000).toISOString() });
  listeners.set("pool", await serveFactoryMetrics(endpoint, "pool", () => collectFactoryPoolMetrics(pool.client, ["tenant-01", "tenant-02"]), { tenant: ["tenant-01", "tenant-02"] }));

  for (const each of ["gateway", "orchestrator"] as const) listeners.set(each, await serveFactoryReadyMetrics(endpoint, each, () => true));
  listeners.set("supervisor", await serveFactoryReadyMetrics(endpoint, "supervisor", () => true, undefined, () => []));
}, 120_000);

afterAll(async () => {
  for (const listener of listeners.values()) await listener.stop();
  await product?.close();
  await pool?.close();
  await rm(root, { recursive: true, force: true });
});

/** The exposition's series: name and label pairs, one per sample line. */
function series(text: string): Array<{ name: string; labels: Record<string, string> }> {
  return text.split("\n").filter((line) => line !== "" && !line.startsWith("#")).map((line) => {
    const match = /^([a-z_][a-z0-9_]*)(?:\{(.*)\})? -?[0-9.e+]+$/.exec(line);
    if (!match) throw new Error(`not an exposition line: ${line}`);
    const labels = Object.fromEntries([...(match[2] ?? "").matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)].map((pair) => [pair[1]!, pair[2]!]));
    return { name: match[1]!, labels };
  });
}

test("every service's scrape holds only its declared, bounded series and no identifier or secret", async () => {
  expect([...listeners.keys()].sort()).toEqual([...FACTORY_METRIC_SERVICES].sort());
  for (const [service, listener] of listeners) {
    expect((await fetch(`${listener.url}/metrics`)).status).toBe(401);
    const response = await fetch(`${listener.url}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET_MARKER);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(IDENTIFIER_SHAPE);
    const counts = new Map<string, number>();
    for (const sample of series(text)) {
      const family = FACTORY_METRIC_FAMILIES.find((candidate) => candidate.name === sample.name);
      expect({ service, name: sample.name, declared: family?.services.includes(service) ?? false }).toEqual({ service, name: sample.name, declared: true });
      expect(Object.keys(sample.labels).sort()).toEqual(Object.keys(family!.labels).sort());
      for (const [label, value] of Object.entries(sample.labels)) {
        const allowed = family!.labels[label]!;
        expect(Array.isArray(allowed) ? allowed.includes(value) : ["tenant-01", "tenant-02"].includes(value)).toBe(true);
      }
      counts.set(sample.name, (counts.get(sample.name) ?? 0) + 1);
    }
    for (const [name, count] of counts) expect({ name, bounded: count <= FACTORY_METRIC_SERIES_MAX }).toEqual({ name, bounded: true });
    // The service's whole declared family set is present, so an alert never watches a series that is absent.
    for (const family of FACTORY_METRIC_FAMILIES.filter((candidate) => candidate.services.includes(service))) expect(counts.has(family.name)).toBe(true);
  }
}, 60_000);
