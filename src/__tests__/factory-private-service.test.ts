import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore } from "../extensions/v4/blobs";
import { factoryPrivateServiceConformance } from "./helpers/factory-private-service-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryPrivateServiceConformance(async () => {
  const { db, pglite } = await setupTestDb();
  const directory = await mkdtemp(join(tmpdir(), "factory-private-service-"));
  return { db, blobs: new FileBlobStore(directory), close: async () => { await pglite.close(); await rm(directory, { recursive: true, force: true }); } };
});
