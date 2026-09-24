import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { FileBlobStore } from "./v4/blobs";

mockDbConnection();

const priorBlobRoot = process.env.EZCORP_EXTENSION_BLOB_ROOT;
const blobRoot = await mkdtemp(join(tmpdir(), "ezcorp-lifecycle-blob-audit-"));
process.env.EZCORP_EXTENSION_BLOB_ROOT = blobRoot;

const { auditHistoricalReleaseBlobStorage, reconcileExtensionLifecycle, RELEASE_BLOB_AUDIT_RELEASE_LIMIT } = await import("./extension-lifecycle-service");

afterAll(async () => {
  await closeTestDb();
  await rm(blobRoot, { recursive: true, force: true });
  if (priorBlobRoot === undefined) delete process.env.EZCORP_EXTENSION_BLOB_ROOT;
  else process.env.EZCORP_EXTENSION_BLOB_ROOT = priorBlobRoot;
});

async function addReleaseRecord(id: string, payload: string): Promise<void> {
  const installation = { id, ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 };
  await getTestDb().execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES (${id}, 'owner', 'global', ${JSON.stringify(installation)})`);
  await getTestDb().execute(sql`INSERT INTO extension_release_records (installation_id, kind, id, payload) VALUES (${id}, 'releases', 'release', ${payload})`);
}

function captureWarning(message: string) {
  const original = process.stderr.write;
  const logged = Promise.withResolvers<string>();
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const line = String(chunk);
    if (line.includes(message)) logged.resolve(line);
    return true;
  }) as typeof process.stderr.write;
  return { logged, restore: () => { process.stderr.write = original; } };
}

test("lifecycle reconciliation audits persisted release blobs without exposing their digests", async () => {
  await setupTestDb();
  const sourceDigest = "a".repeat(64);
  const artifactDigest = "b".repeat(64);
  await addReleaseRecord("missing-release", JSON.stringify({ sourceDigest, artifactDigest }));
  const capture = captureWarning("Extension release blob storage is empty.");
  try {
    await expect(reconcileExtensionLifecycle()).resolves.toBeUndefined();
    const warning = await capture.logged.promise;
    expect(warning).toContain('"condition":"empty"');
    expect(warning).toContain('"missing":2');
    expect(warning).not.toContain(sourceDigest);
    expect(warning).not.toContain(artifactDigest);
  } finally {
    capture.restore();
  }
});

test("a malformed historical release record warns without blocking lifecycle recovery", async () => {
  await setupTestDb();
  await addReleaseRecord("malformed-release", "not json");
  const capture = captureWarning("Extension release blob storage audit unavailable; lifecycle recovery continues.");
  try {
    await expect(reconcileExtensionLifecycle()).resolves.toBeUndefined();
    const warning = await capture.logged.promise;
    expect(warning).toContain('"code":"release_blob_audit_failed"');
    expect(warning).not.toContain("not json");
  } finally {
    capture.restore();
  }
});

test("historical blob audit queries only its capped sample and one sentinel release", async () => {
  await setupTestDb();
  for (let index = 0; index <= RELEASE_BLOB_AUDIT_RELEASE_LIMIT; index++) {
    const id = `capped-release-${index}`;
    const sourceDigest = index.toString(16).padStart(64, "0");
    const artifactDigest = index.toString(16).padStart(64, "f");
    await addReleaseRecord(id, JSON.stringify({ sourceDigest, artifactDigest }));
  }
  const capture = captureWarning("Extension release blob storage is empty in the audited sample.");
  try {
    await expect(auditHistoricalReleaseBlobStorage(new FileBlobStore(blobRoot))).resolves.toBeUndefined();
    const warning = await capture.logged.promise;
    expect(warning).toContain(`"expected":${RELEASE_BLOB_AUDIT_RELEASE_LIMIT * 2}`);
    expect(warning).toContain('"partial":true');
  } finally {
    capture.restore();
  }
});
