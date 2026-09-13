import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryValidatorMaterialsConformance } from "../__tests__/helpers/factory-validator-materials-suite";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { FileBlobStore } from "../extensions/v4/blobs";

factoryValidatorMaterialsConformance(async () => {
  const fixture = await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "factory-validator-materials-"));
  return { db: fixture.db, blobs: new FileBlobStore(root), close: async () => { await fixture.pglite.close(); await rm(root, { recursive: true, force: true }); } };
});
