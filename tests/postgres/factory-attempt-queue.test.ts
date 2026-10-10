import { expect, test } from "bun:test";
import { verifyFactoryAttemptQueue } from "../../src/__tests__/helpers/factory-attempt-queue-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

test("durable attempt queue conforms on real PostgreSQL", async () => {
  await expect(verifyFactoryAttemptQueue(async () => ({ ...await setupFactoryPostgres(), migrated: true }))).resolves.toBeUndefined();
});
