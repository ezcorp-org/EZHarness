/**
 * The composition-owned project enumerator.
 *
 * Two roles iterate projects and neither can be driven without this, so the
 * assertions that matter are the ones a driver depends on: the order is total,
 * a page carries the cursor that continues it, a bound is enforced at both
 * ends, and a row it cannot trust raises instead of quietly leaving the list.
 * A project that disappears from the page is a project whose releases and
 * notifications stop with nothing to say so.
 */
import { describe, expect, test } from "bun:test";
import type { MigrationDb } from "../db/migrations/types";
import {
  FACTORY_PROJECT_SCAN_DEFAULT_LIMIT,
  FACTORY_PROJECT_SCAN_MAX_LIMIT,
  FactoryTenantProjectError,
  factoryTenantProjectIds,
  factoryTenantProjects,
  type FactoryTenantProjectCursor,
} from "./tenant-projects";

type Row = { project_id: string; created_at_ms: number | string };

/** A transaction that answers with fixed rows and records the query it was given. */
function transactionOf(pages: Row[][]): { transaction: MigrationDb; queries: string[]; calls: number } {
  const state = { queries: [] as string[], calls: 0 };
  const transaction = {
    async execute(query: unknown) {
      state.queries.push(JSON.stringify(query));
      return pages[state.calls++] ?? [];
    },
  } as unknown as MigrationDb;
  return { transaction, get queries() { return state.queries; }, get calls() { return state.calls; } };
}

function databaseOf(pages: Row[][]): { database: { transaction<R>(work: (t: MigrationDb) => Promise<R>): Promise<R> }; queries: string[] } {
  const scope = transactionOf(pages);
  return { database: { transaction: (work) => work(scope.transaction) }, get queries() { return scope.queries; } };
}

const page = (...ids: string[]): Row[] => ids.map((id, index) => ({ project_id: id, created_at_ms: 1_700_000_000_000 + index }));

describe("factoryTenantProjects", () => {
  test("refuses a tenant that is not an identity", () => {
    expect(() => factoryTenantProjects("")).toThrow();
    expect(() => factoryTenantProjects("tenant\0null")).toThrow();
  });

  test("returns each project with the cursor that continues the order", async () => {
    const scope = transactionOf([page("project-a", "project-b")]);
    const listed = await factoryTenantProjects("tenant-01").listInTransaction(scope.transaction);

    expect(listed.map((item) => item.projectId)).toEqual(["project-a", "project-b"]);
    expect(listed[1]!.cursor).toEqual({ createdAtMs: 1_700_000_000_001, projectId: "project-b" });
    // Frozen, because a driver passes the cursor straight back into the next
    // page and a mutated cursor would silently skip or repeat rows.
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0]!.cursor)).toBe(true);
  });

  test("orders by the host project's creation with the project id breaking ties", async () => {
    const scope = transactionOf([page("project-a")]);
    await factoryTenantProjects("tenant-01").listInTransaction(scope.transaction);

    const query = scope.queries[0]!;
    // `factory_projects` carries no timestamp, so the order comes from the
    // `projects` row its own foreign key already binds it to.
    expect(query).toContain("factory_projects");
    expect(query).toContain("JOIN projects host ON host.id = bound.project_id");
    expect(query).toContain("ORDER BY ");
    expect(query).toContain("created_at");
    // No lock: enumerating work is not claiming it.
    expect(query).not.toContain("FOR UPDATE");
    expect(query).not.toContain("FOR SHARE");
  });

  test("bounds the page at both ends and defaults when unasked", async () => {
    const projects = factoryTenantProjects("tenant-01");
    const scope = transactionOf([[], [], []]);

    await projects.listInTransaction(scope.transaction);
    expect(scope.queries[0]).toContain(String(FACTORY_PROJECT_SCAN_DEFAULT_LIMIT));

    for (const limit of [0, -1, 1.5, FACTORY_PROJECT_SCAN_MAX_LIMIT + 1, Number.NaN]) {
      await expect(projects.listInTransaction(scope.transaction, { limit })).rejects.toMatchObject({ code: "factory_project_scan_invalid" });
    }
    await expect(projects.listInTransaction(scope.transaction, { limit: FACTORY_PROJECT_SCAN_MAX_LIMIT })).resolves.toEqual([]);
  });

  test("applies a cursor, and refuses one it cannot trust", async () => {
    const projects = factoryTenantProjects("tenant-01");
    const scope = transactionOf([[]]);
    const after: FactoryTenantProjectCursor = { createdAtMs: 1_700_000_000_000, projectId: "project-a" };

    await projects.listInTransaction(scope.transaction, { after });
    expect(scope.queries[0]).toContain("1700000000000");
    expect(scope.queries[0]).toContain("project-a");

    await expect(projects.listInTransaction(scope.transaction, { after: { createdAtMs: -1, projectId: "project-a" } }))
      .rejects.toMatchObject({ code: "factory_project_scan_invalid" });
    await expect(projects.listInTransaction(scope.transaction, { after: { createdAtMs: 1.5, projectId: "project-a" } }))
      .rejects.toMatchObject({ code: "factory_project_scan_invalid" });
    await expect(projects.listInTransaction(scope.transaction, { after: { createdAtMs: 1, projectId: "" } })).rejects.toThrow();
  });

  test("raises on a row it cannot trust rather than dropping it from the page", async () => {
    const projects = factoryTenantProjects("tenant-01");

    // A project that vanished from a worker's list is a project whose releases
    // and notifications stop silently, so every one of these is loud.
    await expect(projects.listInTransaction(transactionOf([[{ project_id: null as unknown as string, created_at_ms: 1 }]]).transaction))
      .rejects.toMatchObject({ code: "factory_project_scan_corrupt" });
    await expect(projects.listInTransaction(transactionOf([[{ project_id: "", created_at_ms: 1 }]]).transaction))
      .rejects.toMatchObject({ code: "factory_project_scan_corrupt" });
    await expect(projects.listInTransaction(transactionOf([[{ project_id: "project-a", created_at_ms: -1 }]]).transaction))
      .rejects.toMatchObject({ code: "factory_project_scan_invalid" });
    await expect(projects.listInTransaction(transactionOf([[{ project_id: "project-a", created_at_ms: "not-a-number" }]]).transaction))
      .rejects.toMatchObject({ code: "factory_project_scan_invalid" });
  });
});

describe("factoryTenantProjectIds", () => {
  test("walks a full tenant one bounded page at a time", async () => {
    const scope = databaseOf([page("project-a", "project-b"), page("project-c", "project-d"), page("project-e")]);
    const ids = await factoryTenantProjectIds(scope.database, factoryTenantProjects("tenant-01"), { limit: 2 });

    expect(ids).toEqual(["project-a", "project-b", "project-c", "project-d", "project-e"]);
    // A short page means the tenant is exhausted, so the walk stops there
    // rather than paying for a page it knows is empty.
    expect(scope.queries).toHaveLength(3);
  });

  test("stops at an empty page, and at the page bound without calling it an error", async () => {
    const empty = databaseOf([[]]);
    expect(await factoryTenantProjectIds(empty.database, factoryTenantProjects("tenant-01"))).toEqual([]);

    // More projects than one pass can hold is not a failure: the next pass
    // starts a fresh scan, which is the right behaviour for a bounded role.
    const many = databaseOf([page("project-a"), page("project-b"), page("project-c")]);
    const ids = await factoryTenantProjectIds(many.database, factoryTenantProjects("tenant-01"), { limit: 1, pages: 2 });
    expect(ids).toEqual(["project-a", "project-b"]);
    expect(many.queries).toHaveLength(2);
  });

  test("stops on a short page at the default limit, and refuses a page bound below one", async () => {
    const scope = databaseOf([page("project-a")]);
    expect(await factoryTenantProjectIds(scope.database, factoryTenantProjects("tenant-01"))).toEqual(["project-a"]);
    expect(scope.queries).toHaveLength(1);

    await expect(factoryTenantProjectIds(scope.database, factoryTenantProjects("tenant-01"), { pages: 0 }))
      .rejects.toBeInstanceOf(FactoryTenantProjectError);
    await expect(factoryTenantProjectIds(scope.database, factoryTenantProjects("tenant-01"), { pages: 1.5 }))
      .rejects.toBeInstanceOf(FactoryTenantProjectError);
  });
});
