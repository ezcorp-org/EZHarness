import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { factoryGuestModelJournalConformance } from "../../__tests__/helpers/factory-guest-model-journal-suite";

factoryGuestModelJournalConformance(async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  await database.waitReady;
  const db = drizzle(database, { schema });
  await migrate(db);
  return { db, close: async () => { await database.close(); } };
});
