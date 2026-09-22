import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FactoryPoolCheckpointSource, factoryDirectRestorePoolLedger, factoryPoolSnapshotFromPages, POOL_CHECKPOINT_PAGE_ROWS } from "../../src/factory/pool/checkpoint";
import { type FactoryPoolLedger, poolRows, type PoolSql } from "../../src/factory/pool/ledger";
import { PoolAdmissionService, type PoolPrincipal } from "../../src/factory/pool/service";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

/**
 * The pool ledger's C06 half on a real pool database: a checkpoint reads the
 * tenant's live reservations in bounded pages, and a restore re-creates the
 * ones a lost ledger forgot as `uncertain`, holding their capacity, and never
 * one whose capacity or host another holder now has.
 */

let database: Awaited<ReturnType<typeof setupFactoryPoolPostgres>>;
let pool: PoolSql;
let service: PoolAdmissionService;
let ledger: FactoryPoolLedger;
const deadline = () => new Date(Date.now() + 3_600_000);
const tenant = (tenantId: string, scopes: readonly string[] = []): PoolPrincipal => ({ kind: "tenant", tenantId, subject: tenantId, scopes: [`pool:tenant:${tenantId}`, ...scopes] });

beforeAll(async () => {
  database = await setupFactoryPoolPostgres();
  pool = database.client as unknown as PoolSql;
  service = new PoolAdmissionService(pool);
  await service.setup();
  ledger = service.ledger;
  await ledger.configureCapacity("cpu", 64);
  for (let index = 0; index < 20; index += 1) await ledger.request({ reservationId: `a-${String(index).padStart(2, "0")}`, tenantId: "tenant-a", grantRevision: 1, resources: { cpu: 1 }, admissionDeadline: deadline() });
  await ledger.request({ reservationId: "b-00", tenantId: "tenant-b", grantRevision: 1, resources: { cpu: 1 }, admissionDeadline: deadline() });
  for (let index = 0; index < 21; index += 1) await ledger.schedule();
  await ledger.request({ reservationId: "a-queued", tenantId: "tenant-a", grantRevision: 1, resources: { cpu: 100 }, admissionDeadline: deadline() });
});
afterAll(async () => { await database?.close(); });

describe("the pool checkpoint", () => {
  test("pages hold only one tenant's live reservations and chain by cursor", async () => {
    const first = await service.checkpoint(tenant("tenant-a"), null);
    expect(first.rows).toHaveLength(POOL_CHECKPOINT_PAGE_ROWS);
    expect(first.rows.every(row => row.tenant_id === "tenant-a" && row.state === "held")).toBe(true);
    expect(first.position).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    const second = await service.checkpoint(tenant("tenant-a"), first.next);
    expect(second.rows.map(row => row.reservation_id)).toEqual(["a-16", "a-17", "a-18", "a-19"]);
    expect(second.next).toBeNull();
    const snapshot = await new FactoryPoolCheckpointSource(pool).snapshotTenant("tenant-a");
    expect(snapshot.rows).toHaveLength(20);
    expect(snapshot.rows.some(row => row.reservation_id === "a-queued")).toBe(false);
    expect(typeof (snapshot.rows[0]!.resources_json as { cpu: number }).cpu).toBe("number");
    await expect(service.checkpoint(tenant("tenant-a"), "")).rejects.toThrow();
    await expect(new FactoryPoolCheckpointSource(pool).page("tenant-a", null, 0)).rejects.toThrow("malformed");
    await expect(factoryPoolSnapshotFromPages(async () => ({ position: "0/0", rows: [], next: "again" }), 3)).rejects.toThrow("page bound");
  });

  test("a restore import needs the restore scope and re-creates lost reservations as uncertain holding their capacity", async () => {
    const snapshot = (await new FactoryPoolCheckpointSource(pool).snapshotTenant("tenant-a")).rows;
    await expect(service.restoreImport(tenant("tenant-a"), snapshot)).rejects.toThrow("scope");
    // Lose three reservations and give their capacity back, as a ledger rebuilt from nothing would.
    await pool.unsafe("DELETE FROM factory_pool_requests WHERE reservation_id IN ('a-00','a-01','a-02')");
    await pool.unsafe("UPDATE factory_pool_resources SET allocated_units = allocated_units - 3 WHERE resource_class = 'cpu'");
    const allocated = async () => Number(poolRows<{ allocated_units: number }>(await pool.unsafe("SELECT allocated_units FROM factory_pool_resources WHERE resource_class = 'cpu'"))[0]!.allocated_units);
    const before = await allocated();
    const result = await service.restoreImport(tenant("tenant-a", ["pool:restore:tenant-a"]), snapshot);
    expect(result.imported).toEqual(["a-00", "a-01", "a-02"]);
    expect(result.overcommitted).toEqual([]);
    expect(result.present).toHaveLength(18);
    expect(await allocated()).toBe(before + 3);
    const restored = (await ledger.status("a-00"))!;
    expect(restored).toMatchObject({ state: "uncertain", reason: "restore-import" });
    expect(restored.allocationGeneration).toBe(Number(snapshot[0]!.allocation_generation) + 1);
    // A second import is a no-op: every row is present now.
    expect((await service.restoreImport(tenant("tenant-a", ["pool:restore:tenant-a"]), snapshot)).imported).toEqual([]);
    await expect(service.restoreImport(tenant("tenant-a", ["pool:restore:tenant-a"]), [{ ...snapshot[0]!, tenant_id: "tenant-b" }])).rejects.toThrow("another tenant");
  });

  test("a lost reservation whose capacity or GPU host another holder now has is overcommitted, not imported", async () => {
    await pool.unsafe("DELETE FROM factory_pool_requests WHERE reservation_id = 'a-03'");
    const row = { reservation_id: "a-03", tenant_id: "tenant-a", grant_revision: 1, resources_json: { cpu: 1000 }, priority: 0, ready_sequence: 0, node_id: "", queued_at: new Date().toISOString(), admission_deadline: deadline().toISOString(), state: "running", allocation_generation: 1, holder_generation: 1, fence: "f", lease_deadline: null, host_id: null, effects: 0, reason: null };
    expect((await new FactoryPoolCheckpointSource(pool).importLost("tenant-a", [row])).overcommitted).toEqual(["a-03"]);
    await ledger.registerGpuHost({ hostId: "gpu-1" });
    await pool.unsafe("UPDATE factory_pool_hosts SET state = 'assigned', reservation_id = 'someone-else', tenant_id = 'tenant-b' WHERE host_id = 'gpu-1'");
    expect((await new FactoryPoolCheckpointSource(pool).importLost("tenant-a", [{ ...row, resources_json: { cpu: 1 }, host_id: "gpu-1" }])).overcommitted).toEqual(["a-03"]);
    await pool.unsafe("UPDATE factory_pool_hosts SET state = 'available', reservation_id = NULL, tenant_id = NULL WHERE host_id = 'gpu-1'");
    expect((await new FactoryPoolCheckpointSource(pool).importLost("tenant-a", [{ ...row, resources_json: { cpu: 1 }, host_id: "gpu-1" }])).imported).toEqual(["a-03"]);
    expect(poolRows<{ state: string; reservation_id: string }>(await pool.unsafe("SELECT state, reservation_id FROM factory_pool_hosts WHERE host_id = 'gpu-1'"))[0]).toEqual({ state: "quarantined", reservation_id: "a-03" });
    // Rows that were not live at the checkpoint never come back.
    expect((await new FactoryPoolCheckpointSource(pool).importLost("tenant-a", [{ ...row, reservation_id: "a-settled", state: "settled" }])).imported).toEqual([]);
  });

  test("the direct restore ledger lists live rows and revokes through the ledger", async () => {
    const direct = factoryDirectRestorePoolLedger(pool, ledger);
    const live = await direct.liveRows("tenant-a");
    expect(live.length).toBeGreaterThan(0);
    const target = live.find(row => row.state === "held")!;
    expect(await direct.revoke(String(target.reservation_id), Number(target.allocation_generation))).toEqual({ state: "revoking" });
    expect((await direct.importLost("tenant-a", [])).imported).toEqual([]);
  });
});
