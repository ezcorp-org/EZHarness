import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { S3BlobStore, s3ObjectKey } from "../../src/extensions/v4/blobs";
import { FactoryArtifacts } from "../../src/factory/artifacts";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

async function fixture() {
  const database = await setupFactoryPostgres(); closes.push(database.close);
  const config = JSON.parse(await readFile("/run/user/1001/ezcorp-factory-storage.8yWJyCIQ/ordinary.json", "utf8")) as { identities: Array<{ name: string; credentials: Array<{ accessKey: string; secretKey: string }> }> };
  const credential = config.identities.find(identity => identity.name === "tenant-01")?.credentials[0];
  if (!credential) throw new Error("Local ordinary storage tenant identity is missing.");
  const credentials = { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
  const client = new S3Client({ endpoint: "http://127.0.0.1:18333", region: "us-east-1", forcePathStyle: true, credentials });
  const prefix = `ordinary/factory-artifacts/${randomUUID()}`;
  const blobs = new S3BlobStore({ endpoint: "http://127.0.0.1:18333", bucket: "tenant-01", prefix, credentials, client });
  const identity = { tenantId: "artifact-tenant", projectId: `artifact-${randomUUID()}`, logicalRunId: `run-${randomUUID()}`, interpreterId: "worker-a" };
  await database.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${identity.projectId}, 'Artifact', '/tmp/artifact')`);
  await database.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${identity.tenantId}, 1)`);
  await database.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${identity.tenantId}, ${identity.projectId})`);
  await database.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${identity.tenantId}, ${identity.projectId}, ${identity.logicalRunId}, ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
  return { database: database.db, client, blobs, identity, prefix };
}

test("PostgreSQL scoped S3 references retain original bytes and reject foreign and changed version records", async () => {
  const { database, client, blobs, identity, prefix } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs);
  const content = new TextEncoder().encode("immutable artifact bytes");
  const reference = await artifacts.stage(identity, "execution_manifest", content, { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
  expect(await artifacts.load(identity, reference, ["execution_manifest"])).toMatchObject({ content });
  await expect(artifacts.load({ ...identity, projectId: "foreign" }, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  const selected = await database.execute(sql`SELECT blob_digest, storage_version FROM factory_artifacts WHERE object_id=${reference.objectId}`) as unknown as { rows?: unknown[] } | unknown[];
  const row = (Array.isArray(selected) ? selected : selected.rows) as Array<{ blob_digest: string; storage_version: string }>;
  await client.send(new PutObjectCommand({ Bucket: "tenant-01", Key: s3ObjectKey(prefix, row[0]!.blob_digest), Body: new TextEncoder().encode("changed artifact bytes") }));
  expect((await artifacts.load(identity, reference, ["execution_manifest"])).content).toEqual(content);
  const changed = await blobs.version(row[0]!.blob_digest);
  expect(changed).not.toBe(row[0]!.storage_version);
  await database.execute(sql`UPDATE factory_artifacts SET storage_version=${changed} WHERE object_id=${reference.objectId}`);
  await expect(artifacts.load(identity, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "artifact_corrupt" });
  client.destroy();
});
