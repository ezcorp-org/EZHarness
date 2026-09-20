import { describe } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { factoryGuestModelJournalConformance } from "../../__tests__/helpers/factory-guest-model-journal-suite";

/**
 * The same conformance twice, over two different round-trip timings.
 *
 * PGlite settles a query through the MICROTASK queue. A real PostgreSQL server
 * settles it through a socket, which is a macrotask, and that difference is not
 * cosmetic: a test that spins on `await Promise.resolve()` waiting for a query
 * enqueues a fresh microtask every turn, so the event loop never reaches its
 * I/O phase, the result can never arrive, and the process burns a core forever.
 * Bun's own per-test timeout is a macrotask too, so it never fires either.
 *
 * That is exactly what happened here: the suite passed on PGlite and hung the
 * registered real-PostgreSQL lane. The second leg below paces every database
 * call onto a macrotask, so the ordinary pool now reproduces the server's
 * timing and this class of defect can no longer hide behind PGlite.
 */

async function pglite() {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  await database.waitReady;
  return database;
}

describe("on PGlite", () => {
  factoryGuestModelJournalConformance(async () => {
    const database = await pglite();
    const db = drizzle(database, { schema });
    await migrate(db);
    return { db, close: async () => { await database.close(); } };
  });
});

describe("on a store whose round trips are macrotasks, as a real server's are", () => {
  factoryGuestModelJournalConformance(async () => {
    const database = await pglite();
    let paced = false;
    // Migration runs at full speed; only the suite's own work is paced.
    const macrotask = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });
    const slowed = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = value.bind(target) as (...args: unknown[]) => unknown;
        if (property !== "query" && property !== "exec" && property !== "transaction") return method;
        return async (...args: unknown[]) => {
          if (paced) await macrotask();
          return method(...args);
        };
      },
    });
    const db = drizzle(slowed as unknown as PGlite, { schema });
    await migrate(db);
    paced = true;
    return { db, close: async () => { paced = false; await database.close(); } };
  });
});
