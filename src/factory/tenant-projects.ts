/**
 * The tenant's factory projects, oldest first, as a composition-owned read.
 *
 * **This file reads a table it does not own, and that is a deliberate, assigned
 * exception rather than an oversight.** `factory_projects` is written by
 * `FactoryRecords.bindProjectInTransaction` and, before this file, read by
 * nothing. Two background roles need it and neither can be driven without it:
 * `FactoryReleases.listClaimableInTransaction` and
 * `FactoryNotificationDelivery.deliverNext` are both PER PROJECT, so an
 * installation-wide loop has to know which projects exist. I declined to add
 * this read on my own initiative for exactly the C13 reason — a second reader of
 * another package's table is the duplication the rule forbids — and the
 * coordinator assigned it here, to the composition, because the composition is
 * what needs to iterate and no package owns "every project in this tenant".
 *
 * It reads, and only reads. Binding a project stays where it is.
 *
 * **Why the order is by the host project's creation.** `factory_projects` is
 * `(tenant_id, project_id)` and carries no timestamp of its own, so "oldest
 * first" has to come from somewhere. The row's own foreign key already binds it
 * to `projects(id)`, which has `created_at`, so the join adds no new coupling
 * that the schema did not already require. `project_id` breaks ties, which
 * makes the order total: a keyset page can then neither repeat nor skip a row.
 * This is the same decision, for the same reason, that W03 recorded for its
 * uncertain-hold scan over a table with no timestamp.
 *
 * **It takes no locks.** Enumerating work is not claiming it. Exclusion between
 * two workers belongs to the act each role performs on a project — `claim` for
 * a release, the inbox's own update for a notification — so two workers may list
 * the same project and only one will commit the work inside it. Holding a lock
 * across a whole page would serialise every role that iterates projects.
 *
 * **It is fail-closed, not fail-quiet.** A row whose project id is not a valid
 * factory identity, or whose creation timestamp is not a safe non-negative
 * integer, raises rather than being dropped from the page. A project that
 * silently disappeared from a worker's list is a project whose releases and
 * notifications stop, with nothing anywhere to say so.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { assertFactoryIdentity } from "./records";

export const FACTORY_PROJECT_SCAN_DEFAULT_LIMIT = 100;
export const FACTORY_PROJECT_SCAN_MAX_LIMIT = 1_000;

export class FactoryTenantProjectError extends Error {
  constructor(readonly code: "factory_project_scan_invalid" | "factory_project_scan_corrupt") {
    super(code);
    this.name = "FactoryTenantProjectError";
  }
}

/** The position of one row in the total order, for the next page. */
export interface FactoryTenantProjectCursor {
  readonly createdAtMs: number;
  readonly projectId: string;
}

export interface FactoryTenantProject {
  readonly projectId: string;
  readonly cursor: FactoryTenantProjectCursor;
}

export interface FactoryTenantProjects {
  readonly tenantId: string;
  listInTransaction(
    transaction: MigrationDb,
    options?: { readonly limit?: number; readonly after?: FactoryTenantProjectCursor },
  ): Promise<readonly FactoryTenantProject[]>;
}

function count(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new FactoryTenantProjectError("factory_project_scan_invalid");
}

export function factoryTenantProjects(tenantId: string): FactoryTenantProjects {
  assertFactoryIdentity(tenantId);
  // Typed before freezing, so the method parameters take their types from the
  // interface rather than from an untyped object literal.
  const store: FactoryTenantProjects = {
    tenantId,
    async listInTransaction(transaction, options = {}): Promise<readonly FactoryTenantProject[]> {
      const limit = options.limit ?? FACTORY_PROJECT_SCAN_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_PROJECT_SCAN_MAX_LIMIT) {
        throw new FactoryTenantProjectError("factory_project_scan_invalid");
      }
      const after = options.after;
      if (after) { count(after.createdAtMs); assertFactoryIdentity(after.projectId); }
      const position = sql`(EXTRACT(EPOCH FROM host.created_at) * 1000)::bigint`;
      const keyset = after
        ? sql` AND (${position}, bound.project_id) > (${after.createdAtMs}, ${after.projectId})`
        : sql``;
      const scanned = rows<{ project_id: string; created_at_ms: number | string }>(await transaction.execute(sql`
        SELECT bound.project_id, ${position} AS created_at_ms
        FROM factory_projects bound
        JOIN projects host ON host.id = bound.project_id
        WHERE bound.tenant_id = ${tenantId}${keyset}
        ORDER BY ${position}, bound.project_id
        LIMIT ${limit}`));
      return Object.freeze(scanned.map((row) => {
        const createdAtMs = Number(row.created_at_ms);
        if (typeof row.project_id !== "string" || row.project_id.length === 0) throw new FactoryTenantProjectError("factory_project_scan_corrupt");
        assertFactoryIdentity(row.project_id);
        count(createdAtMs);
        return Object.freeze({
          projectId: row.project_id,
          cursor: Object.freeze({ createdAtMs, projectId: row.project_id }),
        });
      }));
    },
  };
  return Object.freeze(store);
}

/**
 * Every project in the tenant, walked one bounded page at a time.
 *
 * A role that iterates projects wants all of them, and wants the scan bounded
 * anyway; those two are only compatible if something pages. The page bound is
 * the memory bound, `pages` is the total bound, and reaching the page limit
 * without exhausting the tenant is not an error — the next pass continues from
 * a fresh scan, which is what an installation with more projects than one pass
 * can hold should do rather than failing.
 */
export async function factoryTenantProjectIds(
  database: { transaction<Result>(work: (transaction: MigrationDb) => Promise<Result>): Promise<Result> },
  projects: FactoryTenantProjects,
  options: { readonly limit?: number; readonly pages?: number } = {},
): Promise<readonly string[]> {
  const pages = options.pages ?? 10;
  if (!Number.isSafeInteger(pages) || pages < 1) throw new FactoryTenantProjectError("factory_project_scan_invalid");
  const collected: string[] = [];
  let after: FactoryTenantProjectCursor | undefined;
  for (let page = 0; page < pages; page++) {
    const scanned: readonly FactoryTenantProject[] = await database.transaction((transaction) =>
      projects.listInTransaction(transaction, { ...(options.limit === undefined ? {} : { limit: options.limit }), ...(after === undefined ? {} : { after }) }));
    for (const project of scanned) collected.push(project.projectId);
    if (scanned.length === 0) break;
    after = scanned[scanned.length - 1]!.cursor;
    if (options.limit !== undefined && scanned.length < options.limit) break;
    if (options.limit === undefined && scanned.length < FACTORY_PROJECT_SCAN_DEFAULT_LIMIT) break;
  }
  return Object.freeze(collected);
}
