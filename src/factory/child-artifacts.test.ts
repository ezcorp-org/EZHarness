import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factoryChildArtifactsConformance } from "../__tests__/helpers/factory-child-artifacts-suite";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { FileBlobStore } from "../extensions/v4/blobs";

factoryChildArtifactsConformance(async () => {
  const fixture = await setupTestDb();
  const root = await mkdtemp(join(tmpdir(), "factory-child-artifacts-"));
  return { db: fixture.db, blobs: new FileBlobStore(root), close: async () => { await fixture.pglite.close(); await rm(root, { recursive: true, force: true }); } };
});
