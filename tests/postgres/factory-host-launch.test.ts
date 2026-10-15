import { expect, test } from "bun:test";
import { verifyFactoryHostLaunchEndToEnd } from "../../src/__tests__/helpers/factory-host-launch-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

// Awaited before expect(): a rejection reaches the report with its own message and stack (W4H-12), where
// expect(promise).resolves printed only "Promise { <rejected> }". The helper's expectations do the checking.
test("the attempt-dispatch path through the supervisor conforms on real PostgreSQL", async () => {
  expect(await verifyFactoryHostLaunchEndToEnd({ ...await setupFactoryPostgres(), migrated: true })).toBeUndefined();
}, 600_000);
