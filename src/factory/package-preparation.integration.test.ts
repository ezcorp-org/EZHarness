import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { digestBytes } from "../extensions/v4/blobs";
import { factoryPackagePreparationConformance } from "../__tests__/helpers/factory-package-preparation-suite";

factoryPackagePreparationConformance(async () => {
  const fixture = await setupTestDb();
  const values = new Map<string, Uint8Array>();
  return { db: fixture.db, blobs: {
    async put(bytes: Uint8Array) { const digest = digestBytes(bytes); values.set(digest, bytes.slice()); return digest; },
    async get(digest: string) { const value = values.get(digest); if (!value) throw new Error("blob missing"); return value.slice(); },
  }, close: () => fixture.pglite.close() };
});
