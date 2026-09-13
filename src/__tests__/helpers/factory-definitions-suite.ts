import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { referenceCodeV1, validateFactoryApiResponse, type FactoryDefinition } from "@ezcorp/factory-sdk";
import { FactoryDefinitions } from "../../factory/definitions";
import { FactoryMutations } from "../../factory/mutations";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { digestBytes } from "../../extensions/v4/blobs";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { TransactionalDb } from "../../db/migrations/types";
import { up } from "../../db/migrations/add-factory-definitions";

interface Fixture { readonly db: TransactionalDb; close(): Promise<void> }

export function factoryDefinitionsConformance(createFixture: () => Promise<Fixture>): void {
  let fixture: Fixture;
  let store: FactoryDefinitions;
  let grants: FactoryGrants;
  const actor: FactoryPrincipal = { kind: "user", id: "definition-author", authentication: "session" };
  const administrator: FactoryPrincipal = { kind: "user", id: "definition-admin", authentication: "session" };
  const content = new Map<string, Uint8Array>();
  const blobs = { async put(bytes: Uint8Array) { const digest = digestBytes(bytes); content.set(digest, bytes.slice()); return digest; }, async get(digest: string) { const bytes = content.get(digest); if (!bytes) throw new Error("blob unavailable"); return bytes.slice(); } };
  const key = (factoryId: string) => ({ projectId: "definition-project", factoryId });
  const source = (id: string, version = "1.0.0"): FactoryDefinition => ({ ...structuredClone(referenceCodeV1), id, version });

  beforeAll(async () => {
    fixture = await createFixture();
    await up(fixture.db);
    await up(fixture.db);
    const records = new FactoryRecords(fixture.db, "definition-tenant");
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('definition-project', 'Definitions', '/tmp/definitions'), ('definition-foreign', 'Foreign', '/tmp/foreign-definitions')`);
    await records.bindProject("definition-project");
    await records.bindProject("definition-foreign");
    for (const principal of [actor, administrator]) {
      await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES (${principal.id}, ${`${principal.id}@example.test`}, 'not-a-login', ${principal.id}, ${principal === administrator ? "admin" : "member"})`);
      await fixture.db.execute(sql`INSERT INTO project_members (id, project_id, user_id, role) VALUES (${principal.id}, 'definition-project', ${principal.id}, 'member')`);
    }
    grants = new FactoryGrants(fixture.db, "definition-tenant");
    for (const action of ["factory.author", "factory.publish"] as const) await grants.set(administrator, { projectId: "definition-project", principal: actor, action, expectedRevision: 0, expiresAtMs: null });
    store = new FactoryDefinitions(fixture.db, "definition-tenant", grants, blobs);
  });
  afterAll(async () => { await fixture?.close(); });

  test("draft saves preserve source, race revisions, and resolve exact request retries", async () => {
    const definition = source("draft-race");
    const created = await store.save(actor, key(definition.id), 0, "create-draft", definition);
    expect(created.revision).toBe(1);
    expect((await store.read(actor, key(definition.id))).source).toEqual(definition);
    const saves = await Promise.allSettled([store.save(actor, key(definition.id), 1, "save-a", { ...definition, presentation: { x: 1 } }), store.save(actor, key(definition.id), 1, "save-b", { ...definition, presentation: { x: 2 } })]);
    expect(saves.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(saves.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await store.save(actor, key(definition.id), 0, "create-draft", definition)).toEqual(created);
    await expect(store.save(actor, key(definition.id), 0, "create-draft", { ...definition, version: "2.0.0" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const race = await Promise.allSettled([store.save(actor, key("create-race"), 0, "create-race-a", source("create-race")), store.save(actor, key("create-race"), 0, "create-race-b", source("create-race"))]);
    expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  test("published bytes stay pinned through edits, archive, and repeated publish requests", async () => {
    const definition = source("published");
    await store.save(actor, key(definition.id), 0, "publish-create", definition);
    const version = await store.publish(actor, key(definition.id), 1, "publish-v1");
    const { projectId: _projectId, ...resource } = version;
    expect(validateFactoryApiResponse({ schemaVersion: "factory.api.response.v1", kind: "version.summary", resource })).toEqual({ ok: true });
    expect(Number.isSafeInteger((await store.read(actor, key(definition.id))).updatedAtMs)).toBe(true);
    expect((await store.readVersion(actor, key(definition.id), version.version)).compiled.digest).toBe(version.definitionDigest);
    const transactional = await fixture.db.transaction(transaction => store.readVersionInTransaction(transaction, actor, key(definition.id), version.version));
    expect(transactional.version).toEqual(version);
    expect(transactional.compiled.digest).toBe(version.definitionDigest);
    expect(await store.publish(actor, key(definition.id), 1, "publish-same-content")).toEqual(version);
    await store.save(actor, key(definition.id), 1, "edit-after-publish", { ...definition, presentation: { label: "Changed" } });
    expect(await store.publish(actor, key(definition.id), 1, "publish-v1")).toEqual(version);
    await expect(store.publish(actor, key(definition.id), 2, "publish-conflicting-version")).rejects.toMatchObject({ code: "factory_version_conflict" });
    const removed = await store.archive(actor, key(definition.id), 2, "archive-published");
    expect(removed).toMatchObject({ revision: 3, archived: true });
    expect(await store.archive(actor, key(definition.id), 2, "archive-published")).toEqual(removed);
    expect((await store.readVersion(actor, key(definition.id), version.version)).version).toEqual(version);
    await expect(store.publish(actor, key(definition.id), 3, "publish-archived")).rejects.toMatchObject({ code: "factory_revision_conflict" });
    await expect(store.save(actor, key(definition.id), 3, "save-archived", definition)).rejects.toMatchObject({ code: "factory_revision_conflict" });
    await expect(store.archive(actor, key(definition.id), 3, "archive-again")).rejects.toMatchObject({ code: "factory_revision_conflict" });
  });

  test("publish races save against one draft revision and never publishes mixed content", async () => {
    const definition = source("publish-race");
    await store.save(actor, key(definition.id), 0, "publish-race-create", definition);
    const result = await Promise.allSettled([store.publish(actor, key(definition.id), 1, "publish-race-v1"), store.save(actor, key(definition.id), 1, "publish-race-save", { ...definition, version: "2.0.0" })]);
    expect(result[1]?.status).toBe("fulfilled");
    if (result[0]?.status === "fulfilled") {
      const pinned = await store.readVersion(actor, key(definition.id), "1.0.0");
      expect(pinned.compiled.definition.version).toBe("1.0.0");
      expect(pinned.version.draftRevision).toBe(1);
    } else {
      expect(result[0]?.reason.code).toBe("factory_revision_conflict");
    }
  });

  test("authoring accepts invalid graph semantics while publish returns compiler diagnostics", async () => {
    const initial = source("invalid-semantics");
    const definition = { ...initial, graph: { ...initial.graph, nodes: initial.graph.nodes.map((node, index) => index === 0 ? { ...node, dependsOn: ["missing"] } : node) } };
    expect((await store.save(actor, key(definition.id), 0, "invalid-create", definition)).revision).toBe(1);
    await expect(store.publish(actor, key(definition.id), 1, "invalid-publish")).rejects.toMatchObject({ code: "factory_definition_invalid", diagnostics: expect.any(Array) });
    await expect(store.save(actor, key("unknown-schema"), 0, "unknown", { ...definition, id: "unknown-schema", schemaVersion: "factory.v99" })).rejects.toMatchObject({ code: "factory_definition_schema_invalid" });
    await expect(store.save(actor, key("wrong-id"), 0, "identity", definition)).rejects.toMatchObject({ code: "factory_definition_identity_mismatch" });
    await expect(store.save(actor, key("too-large"), 0, "oversize", { ...source("too-large"), presentation: { text: "x".repeat(16 * 1024 * 1024) } })).rejects.toMatchObject({ code: "factory_definition_too_large" });
  });

  test("JSON and YAML imports export the same definition and versions paginate independently", async () => {
    const definition = source("round-trip");
    const text = canonicalJson(definition);
    expect((await store.import(actor, key(definition.id), 0, "import-json", text, "json")).revision).toBe(1);
    const exported = await store.export(actor, key(definition.id));
    expect(exported).toEqual({ revision: 1, content: text });
    expect((await store.import(actor, key(definition.id), 1, "import-yaml", exported.content, "yaml")).revision).toBe(2);
    expect((await store.validate(actor, key(definition.id))).ok).toBe(true);
    expect((await store.validate(actor, key("invalid-semantics"))).ok).toBe(false);
    await store.publish(actor, key(definition.id), 2, "round-trip-v1");
    await store.save(actor, key(definition.id), 2, "round-trip-edit", source(definition.id, "2.0.0"));
    await store.publish(actor, key(definition.id), 3, "round-trip-v2");
    const first = await store.listVersions(actor, key(definition.id), "", 1);
    expect(first.items.map(version => version.version)).toEqual(["1.0.0"]);
    expect(first.nextCursor).toBe("1.0.0");
    const last = await store.listVersions(actor, key(definition.id), first.nextCursor!);
    expect(last.items.map(version => version.version)).toEqual(["2.0.0"]);
    expect(last.nextCursor).toBeNull();
    expect((await store.listVersions(actor, key("missing"))).items).toEqual([]);
    expect(() => store.import(actor, key(definition.id), 3, "wrong-format", text, "xml" as "json")).toThrow("factory_format_invalid");
  });

  test("authoring metadata supports import identity, archive and search filters, and requested versions", async () => {
    const alpha = source("filter-alpha");
    const beta = source("filter-beta");
    expect((await store.importNew(actor, "definition-project", 0, "import-new", canonicalJson(alpha), "json")).factoryId).toBe(alpha.id);
    await store.save(actor, key(beta.id), 0, "filter-beta-create", beta);
    await store.archive(actor, key(beta.id), 1, "filter-beta-archive");
    expect((await store.listDrafts(actor, "definition-project", { search: "ALPHA" })).items.map(item => item.factoryId)).toContain(alpha.id);
    expect((await store.listDrafts(actor, "definition-project", { archived: true, search: "filter" })).items.map(item => item.factoryId)).toEqual([beta.id]);
    expect((await store.validateSource(actor, key(alpha.id), alpha)).ok).toBe(true);
    await expect(store.validateSource(actor, key(beta.id), { ...alpha, id: beta.id })).resolves.toMatchObject({ ok: true });
    await expect(store.validateSource(actor, key(beta.id), alpha)).rejects.toMatchObject({ code: "factory_definition_identity_mismatch" });
    await expect(store.publish(actor, key(alpha.id), 1, "wrong-requested-version", "2.0.0")).rejects.toMatchObject({ code: "factory_version_conflict" });
    expect((await store.publish(actor, key(alpha.id), 1, "right-requested-version", "1.0.0")).version).toBe("1.0.0");
    await expect(store.listDrafts(actor, "definition-project", { search: "" })).rejects.toMatchObject({ code: "factory_page_invalid" });
  });

  test("scoped reads, pagination, missing resources and stale preconditions fail clearly", async () => {
    const page = await store.list(actor, "definition-project", "", 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0]!.factoryId);
    expect((await store.list(actor, "definition-project", page.nextCursor!, 200)).items.every(item => item.factoryId > page.nextCursor!)).toBe(true);
    expect((await store.list(actor, "definition-project")).items.every(item => !item.archived)).toBe(true);
    expect((await store.list(actor, "definition-project", "zzzz")).nextCursor).toBeNull();
    await expect(store.read(administrator, { projectId: "definition-foreign", factoryId: "published" })).rejects.toMatchObject({ code: "factory_forbidden" });
    await expect(store.read(actor, key("missing"))).rejects.toMatchObject({ code: "factory_definition_not_found" });
    await expect(store.readVersion(actor, key("published"), "missing")).rejects.toMatchObject({ code: "factory_version_not_found" });
    await expect(store.list(actor, "definition-project", "", 201)).rejects.toMatchObject({ code: "factory_page_invalid" });
    await expect(store.save(actor, key("bad-revision"), -1, "bad", source("bad-revision"))).rejects.toMatchObject({ code: "factory_revision_invalid" });
    await expect(store.publish(actor, key("draft-race"), 1, "stale-publish")).rejects.toMatchObject({ code: "factory_revision_conflict" });
    expect(() => new FactoryDefinitions(fixture.db, "foreign", grants, blobs)).toThrow("factory_scope_mismatch");
  });

  test("authority is rechecked for cached results and membership removal closes reads", async () => {
    const definition = source("revoked");
    const saved = await store.save(actor, key(definition.id), 0, "revoked-create", definition);
    await grants.revoke(administrator, { projectId: "definition-project", principal: actor, action: "factory.author", expectedRevision: 1 });
    await expect(store.save(actor, key(definition.id), 0, "revoked-create", definition)).rejects.toMatchObject({ code: "factory_forbidden" });
    await grants.set(administrator, { projectId: "definition-project", principal: actor, action: "factory.author", expectedRevision: 2, expiresAtMs: null });
    expect(await store.save(actor, key(definition.id), 0, "revoked-create", definition)).toEqual(saved);
    await fixture.db.execute(sql`DELETE FROM project_members WHERE id=${actor.id}`);
    await expect(store.read(actor, key(definition.id))).rejects.toMatchObject({ code: "factory_forbidden" });
    await fixture.db.execute(sql`INSERT INTO project_members (id, project_id, user_id, role) VALUES (${actor.id}, 'definition-project', ${actor.id}, 'member')`);
  });

  test("failed mutations roll back effects and receipts, and incomplete receipts fail closed", async () => {
    const mutations = new FactoryMutations(fixture.db, "definition-tenant", grants);
    const request = { projectId: "definition-project", principal: actor, action: "factory.author" as const, idempotencyKey: "rollback", input: { operation: "test" } };
    await expect(mutations.execute(request, async transaction => { await transaction.execute(sql`UPDATE factory_drafts SET archived=TRUE WHERE factory_id='revoked'`); throw new Error("injected failure"); })).rejects.toThrow("injected failure");
    expect((await store.read(actor, key("revoked"))).archived).toBe(false);
    expect(rows(await fixture.db.execute(sql`SELECT 1 FROM factory_mutation_receipts WHERE idempotency_key='rollback'`))).toHaveLength(0);
    expect(await mutations.execute(request, async () => ({ durable: true }))).toEqual({ durable: true });
    await fixture.db.execute(sql`UPDATE factory_mutation_receipts SET response_json='{"durable":false}' WHERE idempotency_key='rollback'`);
    await expect(mutations.execute(request, async () => ({ durable: false }))).rejects.toMatchObject({ code: "factory_receipt_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_mutation_receipts SET response_json=NULL WHERE idempotency_key='rollback'`);
    await expect(mutations.execute(request, async () => ({ durable: false }))).rejects.toMatchObject({ code: "factory_receipt_incomplete" });
    await expect(mutations.execute({ ...request, idempotencyKey: "" }, async () => true)).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    await expect(mutations.execute({ ...request, idempotencyKey: "oversize-response" }, async () => "x".repeat(65536))).rejects.toMatchObject({ code: "factory_payload_too_large" });
  });

  test("storage corruption cannot be read or published as trusted content", async () => {
    const definition = source("corrupt");
    await store.save(actor, key(definition.id), 0, "corrupt-create", definition);
    const version = await store.publish(actor, key(definition.id), 1, "corrupt-publish");
    const original = content.get(version.compiledBlobDigest)!;
    content.set(version.compiledBlobDigest, new TextEncoder().encode("{}"));
    await expect(store.readVersion(actor, key(definition.id), version.version)).rejects.toMatchObject({ code: "factory_definition_corrupt" });
    content.set(version.compiledBlobDigest, original);
    const forged = JSON.parse(new TextDecoder().decode(original)); forged.digest = `sha256:${"a".repeat(64)}`;
    const bytes = new TextEncoder().encode(canonicalJson(forged)); const forgedDigest = await blobs.put(bytes);
    await fixture.db.execute(sql`UPDATE factory_versions SET compiled_blob_digest=${forgedDigest}, compiled_bytes=${bytes.byteLength} WHERE factory_id='corrupt'`);
    await expect(store.readVersion(actor, key(definition.id), version.version)).rejects.toMatchObject({ code: "factory_definition_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_drafts SET source_digest='wrong' WHERE factory_id='corrupt'`);
    await expect(store.read(actor, key(definition.id))).rejects.toMatchObject({ code: "factory_definition_corrupt" });
    const badStore = new FactoryDefinitions(fixture.db, "definition-tenant", grants, { ...blobs, async put() { return "incorrect"; } });
    await expect(badStore.publish(actor, key("draft-race"), 2, "bad-blob-response")).rejects.toMatchObject({ code: "factory_definition_corrupt" });
  });
}
