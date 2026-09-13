import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { verifyFactoryAttemptQueue } from "../__tests__/helpers/factory-attempt-queue-suite";

test("durable attempt queue conforms on PGlite", async () => {
  await expect(verifyFactoryAttemptQueue(async () => {
    const database = new PGlite({ extensions: { vector, pg_trgm } });
    await database.waitReady;
    return { db: drizzle(database, { schema }), close: () => database.close() };
  })).resolves.toBeUndefined();
});
