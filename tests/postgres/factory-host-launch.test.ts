import { test } from "bun:test";
import { verifyFactoryHostLaunchEndToEnd } from "../../src/__tests__/helpers/factory-host-launch-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

// Awaited directly: a rejection reaches the report with its own message and stack (W4H-12).
// The helper's own expectations are the assertions.
test("the attempt-dispatch path through the supervisor conforms on real PostgreSQL", async () => {
  await verifyFactoryHostLaunchEndToEnd({ ...await setupFactoryPostgres(), migrated: true });
}, 600_000);
