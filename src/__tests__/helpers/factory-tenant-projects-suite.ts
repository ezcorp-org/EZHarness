/**
 * The project enumerator against a real engine.
 *
 * The unit tests drive a fake transaction, which can prove the mapping, the
 * bounds, and the refusals but cannot prove the one thing a driver most depends
 * on: that the SQL is valid, that the join to `projects` finds the row the
 * foreign key already guarantees, and that the keyset partitions the tenant
 * without repeating or skipping. Those are engine facts, so they are asserted
 * here, on both engines the product runs against.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FactoryRecords } from "../../factory/records";
import {
  factoryTenantProjectIds,
  factoryTenantProjects,
  type FactoryTenantProjects,
} from "../../factory/tenant-projects";
import type { TransactionalDb } from "../../db/migrations/types";

interface ProjectFixture { readonly db: TransactionalDb; close(): Promise<void> }

export function factoryTenantProjectsConformance(createFixture: () => Promise<ProjectFixture>): void {
describe("the composition-owned project enumerator, on a real engine", () => {
  let fixture: ProjectFixture;
  let projects: FactoryTenantProjects;

  // Three bound projects created oldest to newest, plus one host project that
  // is never bound and one project bound to nobody's tenant but this one.
  const bound = ["project-alpha", "project-beta", "project-gamma"];

  beforeAll(async () => {
    fixture = await createFixture();
    const records = new FactoryRecords(fixture.db, "tenant-one");
    await records.bindInstallation();
    // Distinct creation instants, ascending, so "oldest first" has something to
    // order by that is not the id.
    for (const [index, projectId] of bound.entries()) {
      await fixture.db.execute(sql`INSERT INTO projects (id, name, path, created_at) VALUES (${projectId}, ${projectId}, ${`/tmp/${projectId}`}, NOW() - ${sql.raw(`INTERVAL '${bound.length - index} hours'`)})`);
      await records.bindProject(projectId);
    }
    await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('project-unbound', 'Unbound', '/tmp/project-unbound')`);
    projects = factoryTenantProjects("tenant-one");
  });
  afterAll(async () => { await fixture?.close(); });

  test("lists exactly the tenant's bound projects, oldest first", async () => {
    const listed = await fixture.db.transaction((transaction) => projects.listInTransaction(transaction));

    // `project-unbound` has a host row and no `factory_projects` binding, so it
    // is not this tenant's work and must not appear.
    expect(listed.map((item) => item.projectId)).toEqual(bound);
    expect(listed[0]!.cursor.createdAtMs).toBeLessThan(listed[2]!.cursor.createdAtMs);
  });

  test("answers nothing for a tenant with no bound projects", async () => {
    const other = factoryTenantProjects("tenant-two");
    expect(await fixture.db.transaction((transaction) => other.listInTransaction(transaction))).toEqual([]);
  });

  test("a keyset page partitions the tenant without repeating or skipping", async () => {
    const first = await fixture.db.transaction((transaction) => projects.listInTransaction(transaction, { limit: 2 }));
    const second = await fixture.db.transaction((transaction) => projects.listInTransaction(transaction, { limit: 2, after: first[1]!.cursor }));
    const past = await fixture.db.transaction((transaction) => projects.listInTransaction(transaction, { after: second[0]!.cursor }));

    expect(first.map((item) => item.projectId)).toEqual(["project-alpha", "project-beta"]);
    expect(second.map((item) => item.projectId)).toEqual(["project-gamma"]);
    // A cursor past the end returns nothing rather than wrapping.
    expect(past).toEqual([]);
    expect([...first, ...second].map((item) => item.projectId)).toEqual(bound);
  });

  test("the page walk collects the whole tenant through a real transaction", async () => {
    expect(await factoryTenantProjectIds(fixture.db, projects, { limit: 1 })).toEqual(bound);
  });

  test("two concurrent scans agree, because the scan takes no lock", async () => {
    // Enumerating work is not claiming it: exclusion belongs to the act each
    // role performs on a project. A scan that locked would serialise every
    // role that iterates projects.
    const [left, right] = await Promise.all([
      fixture.db.transaction((transaction) => projects.listInTransaction(transaction)),
      fixture.db.transaction((transaction) => projects.listInTransaction(transaction)),
    ]);
    expect(left.map((item) => item.projectId)).toEqual(right.map((item) => item.projectId));
  });
});
}
