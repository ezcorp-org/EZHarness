import { expect, test } from "bun:test";
import { getTestDb, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { exercisePersonalPrAuthorityUpgrade } from "../../__tests__/helpers/github-personal-pr-upgrade";

test("legacy private import rows retain bytes and identity across the additive authority migration and rerun", async () => {
  await setupTestDb();
  const result = await exercisePersonalPrAuthorityUpgrade(getTestDb());
  expect(result.after).toEqual(result.before);
  expect(result.afterRerun).toEqual(result.before);
  expect(result.authority).toBeNull();
  expect(result.after!.state).toBe("ready");
});
