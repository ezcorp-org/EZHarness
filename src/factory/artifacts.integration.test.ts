import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import { loadCompiledFactory } from "../../packages/@ezcorp/factory-orchestrator/src/definition-pages";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { FileBlobStore } from "../extensions/v4/blobs";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { FactoryArtifacts } from "./artifacts";
import { createFactoryArtifactActivities } from "./artifact-activities";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";

const databases: PGlite[] = [];
const directories: string[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const database = new PGlite({ extensions: { vector, pg_trgm } }); databases.push(database); await database.waitReady;
  const db = drizzle(database, { schema }); await migrate(db);
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('artifact-project', 'Artifact', '/tmp/artifact')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'artifact-tenant', 1)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('artifact-tenant', 'artifact-project')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('artifact-tenant', 'artifact-project', 'artifact-run', ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
  const root = await mkdtemp(join(tmpdir(), "factory-artifacts-")); directories.push(root);
  const artifacts = new FactoryArtifacts(db, new FileBlobStore(root));
  const definitions = new FactoryDefinitionArtifacts(artifacts);
  const transitions = new FactoryTransitionArtifacts(artifacts);
  return { db, artifacts, definitions, transitions, identity: { tenantId: "artifact-tenant", projectId: "artifact-project", logicalRunId: "artifact-run", interpreterId: "interpreter-a" } };
}

test("host-issued definition references load exact canonical compiler bytes through the Node reader", async () => {
  const { artifacts, definitions, identity } = await fixture();
  const result = compileFactory(referenceCodeV1); if (!result.ok) throw new Error("reference compiler fixture failed");
  const source = await definitions.stageDefinition(result.factory, identity);
  const loaded = await loadCompiledFactory(identity, source, { loadManifestPage: request => definitions.loadManifestPage(request, request.definition, request.page), loadDefinitionPage: request => definitions.loadDefinitionPage(request, request.definitionDigest, request.page) });
  expect(loaded.digest).toBe(result.factory.digest);
  await expect(artifacts.load({ ...identity, projectId: "foreign-project" }, source.manifest, ["definition_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  await expect(artifacts.load(identity, { ...source.manifest, digest: `sha256:${"0".repeat(64)}` }, ["definition_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
});

test("definition manifests use bounded linked pages at the 512-page edge", async () => {
  const { artifacts, definitions, identity } = await fixture();
  const definitionDigest = `sha256:${"b".repeat(64)}`;
  const references = [] as Array<{ objectId: string; digest: string; encodedBytes: number; index: number }>;
  for (let index = 0; index < 512; index += 1) {
    references.push({ ...await artifacts.stage(identity, "definition_page", new Uint8Array([index % 256]), { definitionDigest, pageIndex: index, interpreterScoped: false }), index });
  }
  const chain = definitions as unknown as { stageManifestChain(identity: FactoryIdentity, digest: string, byteLength: number, pages: typeof references): Promise<{ objectId: string; digest: string; encodedBytes: number }> };
  const first = await chain.stageManifestChain(identity, definitionDigest, 512, references);
  const page = await definitions.loadManifestPage(identity, { definitionDigest, definitionEncodedBytes: 512, manifest: first }, first);
  expect(page.pages.length).toBeLessThan(512);
  expect(page.next).toBeDefined();
}, 30_000);

test("execution manifests and partitions keep their definition scope", async () => {
  const { definitions, identity } = await fixture();
  const definitionDigest = `sha256:${"c".repeat(64)}`;
  const execution = await definitions.stageExecutionManifest({ partitionId: "partition-a" } as never, identity, definitionDigest);
  const partition = await definitions.stagePartition({ id: "partition-a" } as never, identity, definitionDigest);
  expect(await definitions.loadExecutionManifest(identity, definitionDigest, execution) as unknown).toEqual({ partitionId: "partition-a" });
  expect(await definitions.loadPartition(identity, definitionDigest, partition) as unknown).toEqual({ id: "partition-a" });
  await expect(definitions.loadPartition(identity, `sha256:${"d".repeat(64)}`, partition)).rejects.toMatchObject({ code: "factory_definition_not_found" });
});

test("transition pages finalize before the existing compact Factory audit stream records them", async () => {
  const { artifacts, definitions, transitions, identity } = await fixture();
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const event = { id: "event-1", kind: "node-succeeded", atMs: 1 } as never;
  const state = { definitionDigest: `sha256:${"a".repeat(64)}` } as never;
  await persistTransition(identity, 1, event, state, [], undefined, activity);
  const rows = await (artifacts.database as typeof artifacts.database).execute(sql`SELECT source_sequence, payload FROM factory_audit_batches WHERE tenant_id='artifact-tenant'`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
  await expect(artifacts.load(identity, { objectId: "guessed", digest: `sha256:${"a".repeat(64)}`, encodedBytes: 1 }, ["transition_manifest"], true)).rejects.toMatchObject({ code: "factory_artifact_not_found" });
});
