import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";

mockDbConnection();

const priorBlobRoot = process.env.EZCORP_EXTENSION_BLOB_ROOT;
const blobRoot = await mkdtemp(join(tmpdir(), "ezcorp-lifecycle-blob-audit-"));
process.env.EZCORP_EXTENSION_BLOB_ROOT = blobRoot;

const { reconcileExtensionLifecycle } = await import("./extension-lifecycle-service");

afterAll(async () => {
  await closeTestDb();
  await rm(blobRoot, { recursive: true, force: true });
  if (priorBlobRoot === undefined) delete process.env.EZCORP_EXTENSION_BLOB_ROOT;
  else process.env.EZCORP_EXTENSION_BLOB_ROOT = priorBlobRoot;
});

test("lifecycle reconciliation audits the release blob store before recovering installations", async () => {
  await setupTestDb();
  await expect(reconcileExtensionLifecycle()).resolves.toBeUndefined();
});
