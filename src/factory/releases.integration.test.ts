import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryReleaseConformance } from "../__tests__/helpers/factory-release-suite";

factoryReleaseConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});

/**
 * The consent reader reads W05's approvals table. This is the check that it never writes it.
 *
 * The C13 boundary gate expresses module imports, not table access, and it cannot carry this rule:
 * adding `src/factory/assurance.ts` to `SHARED_REUSE_MODULES` so the edge could be declared makes
 * the gate red, because the F13 duplicate scan is retroactive and the module then flags its own
 * three exported classes (`FactoryAssuranceError`, `FactoryAssuranceClaimError`,
 * `FactoryAssurance`). That was measured, not assumed. So the ownership rule is enforced here, by
 * reading the source: every statement in `releases.ts` that names `factory_release_approvals` must
 * be a SELECT. `consumeApprovalInTransaction` in W05's own file stays the only thing that changes a
 * row.
 */
test("releases.ts only ever selects from W05's approvals table", async () => {
  const source = await readFile(new URL("./releases.ts", import.meta.url), "utf8");
  const statements = [...source.matchAll(/sql`([\s\S]*?)`/g)]
    .map(match => match[1]!)
    .filter(statement => statement.includes("factory_release_approvals"));
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    const verb = statement.trim().split(/\s+/)[0]!.toUpperCase();
    expect([statement.slice(0, 60).replace(/\s+/g, " "), verb]).toEqual([statement.slice(0, 60).replace(/\s+/g, " "), "SELECT"]);
  }
  // And nothing anywhere in the file mutates it, however the statement is spelled.
  for (const verb of ["INSERT INTO factory_release_approvals", "UPDATE factory_release_approvals", "DELETE FROM factory_release_approvals"]) {
    expect([verb, source.includes(verb)]).toEqual([verb, false]);
  }
});
