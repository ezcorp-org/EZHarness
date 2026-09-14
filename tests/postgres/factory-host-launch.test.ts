import { expect, test } from "bun:test";
import { verifyFactoryHostLaunchEndToEnd } from "../../src/__tests__/helpers/factory-host-launch-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

test("the attempt-dispatch path through the supervisor conforms on real PostgreSQL", async () => {
  await expect(verifyFactoryHostLaunchEndToEnd({ ...await setupFactoryPostgres(), migrated: true })).resolves.toBeUndefined();
}, 600_000);
