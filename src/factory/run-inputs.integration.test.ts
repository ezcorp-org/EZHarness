import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryRunInputsConformance } from "../__tests__/helpers/factory-run-inputs-suite";
import { FileBlobStore } from "../extensions/v4/blobs";

factoryRunInputsConformance(async () => {
  const database = await setupTestDb();
  const directory = await mkdtemp(join(tmpdir(), "factory-run-inputs-"));
  return { db: database.db, blobs: new FileBlobStore(directory), async close() { await database.pglite.close(); await rm(directory, { recursive: true, force: true }); } };
});
