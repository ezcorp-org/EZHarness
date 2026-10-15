import { afterAll, beforeAll, expect, test } from "bun:test";
import { exercisePersonalPrAuthorityUpgrade } from "../../src/__tests__/helpers/github-personal-pr-upgrade";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => { fixture = await setupFactoryPostgres(); });
afterAll(async () => { await fixture?.close(); });

test("supported PostgreSQL driver preserves legacy import identity and bytes on migration and rerun", async () => {
  const result = await exercisePersonalPrAuthorityUpgrade(fixture.db);
  expect(result.after).toEqual(result.before);
  expect(result.afterRerun).toEqual(result.before);
  expect(result.authority).toBeNull();
  expect(result.after!.state).toBe("ready");
});
