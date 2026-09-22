import { SQL } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { factoryArchiveWriterWorld } from "../../src/__tests__/helpers/factory-archive-writer-suite";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * C04 declare race, driven rather than raced.
 *
 * `prepare` mints the operation id as a digest of an identity that is a strict superset of the nine
 * columns the table's second unique arbiter covers — declared in `src/db/schema.ts` as
 * `idx_factory_release_operations_identity`, but created by the migration as an inline table
 * constraint, so PostgreSQL names it
 * `factory_release_operations_tenant_id_project_id_run_id_node_key`. Two identical declarations
 * therefore always collide on BOTH that constraint and `factory_release_operations_pkey`.
 * PostgreSQL only converges on the index named in the conflict target; a collision on any other
 * unique index raises 23505. Ambient concurrency hits that window perhaps one run in twenty, which
 * is why this producer forces it instead of waiting for it.
 *
 * A `BEFORE INSERT` row trigger runs before the ON CONFLICT arbiter pre-check, so parking both
 * declarations there and releasing them together guarantees neither has probed the index nor
 * written an index tuple when the other probes. That is the exact interleaving the bug needs.
 */
const TENANT = "archive-tenant";
/**
 * One advisory key in every process. The LOCK is per-database and each test owns a freshly created
 * database, so two concurrent runs never block each other — but `pg_locks` is cluster-wide, so the
 * readiness count must filter by database or a parallel run's waiters are counted as this one's.
 */
const BARRIER_KEY = 70_707;

describe("C04 concurrent release declarations converge on one operation", () => {
  const disposers: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())); });

  async function setup() {
    const database = await setupFactoryPostgres();
    const world = await factoryArchiveWriterWorld({ db: database.db, async close() {} });
    // A connection outside the pool: it holds the barrier and observes the waiters.
    const control = new SQL(database.databaseUrl, { max: 1 });
    disposers.push(async () => {
      await control.close();
      await database.close();
      await rm(world.root, { recursive: true, force: true });
    });
    return { world, control, database };
  }

  /** Parks every `factory_release_operations` insert until the exclusive advisory lock is released. */
  async function armBarrier(control: SQL) {
    await control.unsafe(`CREATE FUNCTION w07c_declare_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock_shared(${BARRIER_KEY}); RETURN NEW; END $$`);
    await control.unsafe(`CREATE TRIGGER w07c_declare_barrier BEFORE INSERT ON factory_release_operations
      FOR EACH ROW EXECUTE FUNCTION w07c_declare_barrier()`);
    await control.unsafe(`SELECT pg_advisory_lock(${BARRIER_KEY})`);
  }

  /**
   * The count of backends blocked in the trigger: the observed fact the release waits on.
   *
   * The `database` predicate is load-bearing. An advisory locktag carries `MyDatabaseId`, so the
   * set that BLOCKS is already per-database; `pg_locks` is not, so without it a parallel copy of
   * this file in its own database is counted here and `awaitParked` fails on an exact match.
   */
  async function parked(control: SQL): Promise<number> {
    const [row] = await control.unsafe(
      `SELECT count(*)::int AS waiting FROM pg_locks
       WHERE locktype='advisory' AND classid=0 AND objid=${BARRIER_KEY} AND objsubid=1 AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    return Number((row as { waiting: number }).waiting);
  }

  async function awaitParked(control: SQL, expected: number): Promise<number> {
    let observed = 0;
    for (let poll = 0; poll < 600 && observed < expected; poll += 1) {
      observed = await parked(control);
      if (observed < expected) await Bun.sleep(25);
    }
    if (observed !== expected) throw new Error(`the barrier never parked ${expected} declarations; observed ${observed}`);
    return observed;
  }

  const operationRows = async (world: Awaited<ReturnType<typeof setup>>["world"]) =>
    rows<{ operation_id: string; destination_object: string; expected_destination_version: string | null }>(
      await world.db.execute(sql`SELECT operation_id,destination_object,expected_destination_version
        FROM factory_release_operations WHERE tenant_id=${TENANT} AND project_id=${world.projectId}
        ORDER BY operation_id`));

  test("two declarations of the same operation released together return one identity and write one row", async () => {
    const { world, control } = await setup();
    await armBarrier(control);

    // Both reach the insert and stop before the arbiter pre-check.
    const left = world.prepare("converge", "converge-left");
    const right = world.prepare("converge", "converge-right");
    expect(await awaitParked(control, 2)).toBe(2);

    // Released together, so each probes an index the other has not yet written to.
    await control.unsafe(`SELECT pg_advisory_unlock(${BARRIER_KEY})`);
    const [first, second] = await Promise.all([left, right]);

    expect(first.operationId).toBe(second.operationId);
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.materialDigest).toBe(second.materialDigest);
    expect(first.destinationDigest).toBe(second.destinationDigest);
    expect(first.deadlineMs).toBe(second.deadlineMs);
    expect([first.state, second.state]).toEqual(["pending", "pending"]);
    expect([first.archiveReady, second.archiveReady]).toEqual([true, true]);

    // One row, and it is the identity both callers were handed.
    const persisted = await operationRows(world);
    expect(persisted.map(row => row.operation_id)).toEqual([first.operationId]);
    expect(persisted[0]!.destination_object).toBe("releases/converge");

    // The converged operation is a normal claimable operation, not a half-written one.
    expect(await world.claim(first)).toMatchObject({ state: "executing" });
  });

  test("a different operation sharing the nine-column identity is refused by name, never merged", async () => {
    const { world } = await setup();
    const declared = await world.prepare("distinct", "distinct-first");

    // Same run, node, candidate generation, action, provider, account and object — so the same row
    // in the identity index — but an expected destination version the operation id also digests.
    await expect(world.prepare("distinct", "distinct-second", { expectedVersion: "version-9" }))
      .rejects.toMatchObject({ code: "factory_release_conflict" });

    // Refused, so the first operation is untouched and no second row was written.
    const persisted = await operationRows(world);
    expect(persisted.map(row => row.operation_id)).toEqual([declared.operationId]);
    expect(persisted[0]!.expected_destination_version).toBeNull();
    const reread = await world.releases.inspect(world.projectId, declared.operationId);
    expect(reread?.requestDigest).toBe(declared.requestDigest);
    expect(reread?.state).toBe("pending");
  });

  test("a primary-key collision the identity index cannot see is refused by name, never raised", async () => {
    const { world } = await setup();
    const declared = await world.prepare("pk-only", "pk-only-first");

    // The same collision as the race above, held still. An operation id repeats only when the
    // identity it digests repeats, so the one state where the primary key collides while the
    // nine-column index does not is a row whose id no longer matches its identity; it is seeded
    // here directly. This needs no interleaving, so it pins the statement's conflict handling
    // rather than a window: with the identity index as the only conflict target the insert raised
    // 23505 on factory_release_operations_pkey every time.
    await world.db.execute(sql`UPDATE factory_release_operations SET destination_object='releases/pk-only-moved'
      WHERE tenant_id=${TENANT} AND project_id=${world.projectId} AND operation_id=${declared.operationId}`);

    const outcome = await world.prepare("pk-only", "pk-only-second")
      .then(() => "declared", (error: { code?: string }) => error.code ?? "unnamed");
    expect(outcome).toBe("factory_release_corrupt");
    expect((await operationRows(world)).map(row => row.destination_object)).toEqual(["releases/pk-only-moved"]);
  });

  test("two operations cannot share a primary key, because the id digests a superset of that index", async () => {
    const { world } = await setup();
    const declared = await world.prepare("superset", "superset-first");
    const varied = await world.prepare("superset", "superset-second", { expectedVersion: "version-9" })
      .then(operation => operation.operationId, (error: { code?: string }) => error.code);

    // The identity-index columns are equal and the ids still differ: an operation id can only repeat
    // when every field it digests repeats, so a shared primary key always means the same declaration.
    expect(varied).toBe("factory_release_conflict");
    const same = await world.prepare("superset", "superset-third");
    expect(same.operationId).toBe(declared.operationId);
    expect((await operationRows(world)).map(row => row.operation_id)).toEqual([declared.operationId]);
  });
});
