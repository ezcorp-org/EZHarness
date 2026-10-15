import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupIsolatedTestDb } from "../__tests__/helpers/test-pglite";
import { factoryConsoleConformance } from "../__tests__/helpers/factory-console-suite";
import { FileBlobStore } from "../extensions/v4/blobs";

factoryConsoleConformance(async () => {
  const database = await setupIsolatedTestDb();
  const directory = await mkdtemp(join(tmpdir(), "factory-console-"));
  return { db: database.db, blobs: new FileBlobStore(directory), async close() { await database.pglite.close(); await rm(directory, { recursive: true, force: true }); } };
});
