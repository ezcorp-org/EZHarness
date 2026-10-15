import { afterEach } from "bun:test";
import { digestBytes } from "../extensions/v4/blobs";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryLazyCommandsConformance } from "../__tests__/helpers/factory-lazy-commands-suite";

const contents: Array<Map<string, Uint8Array>> = [];

afterEach(() => { contents.length = 0; });

factoryLazyCommandsConformance(async () => {
  const database = await setupTestDb();
  const content = new Map<string, Uint8Array>();
  contents.push(content);
  return {
    db: database.db,
    blobs: {
      async put(bytes) { const digest = digestBytes(bytes); content.set(digest, Uint8Array.from(bytes)); return digest; },
      async get(digest) { const bytes = content.get(digest); if (!bytes) throw new Error("missing fixture blob"); return Uint8Array.from(bytes); },
    },
    async close() { await database.pglite.close(); },
  };
});
