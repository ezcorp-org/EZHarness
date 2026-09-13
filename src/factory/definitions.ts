import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { compileFactory } from "@ezcorp/factory-sdk/compiler";
import { isFactoryDefinition } from "@ezcorp/factory-sdk/schema";
import { FACTORY_LIMITS, parseFactoryJson, parseFactoryYaml, type CompiledFactory, type CompileResult, type FactoryDefinition } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import { assertFactoryIdentity } from "./records";
import { FactoryMutations } from "./mutations";
import type { FactoryGrants, FactoryPrincipal } from "./grants";

const MAX_DEFINITION_BYTES = FACTORY_LIMITS.maxDefinitionBytes;
export interface FactoryDefinitionKey { readonly projectId: string; readonly factoryId: string }
export interface FactoryDraftMetadata extends FactoryDefinitionKey { readonly revision: number; readonly sourceDigest: string; readonly archived: boolean }
export interface FactoryDraft extends FactoryDraftMetadata { readonly source: FactoryDefinition }
export interface FactoryVersion extends FactoryDefinitionKey { readonly version: string; readonly draftRevision: number; readonly definitionDigest: string; readonly compiledBlobDigest: string; readonly compiledBytes: number }
type DraftRow = { revision: number | string; source_digest: string; source_json: string; archived: boolean };
type VersionRow = { version: string; draft_revision: number | string; definition_digest: string; compiled_blob_digest: string; compiled_bytes: number };

export class FactoryDefinitionError extends Error {
  constructor(readonly code: string, readonly diagnostics?: unknown) { super(code); this.name = "FactoryDefinitionError"; }
}

function revision(value: number, creation = false): void {
  if (!Number.isSafeInteger(value) || value < (creation ? 0 : 1) || value >= Number.MAX_SAFE_INTEGER) throw new FactoryDefinitionError("factory_revision_invalid");
}

function sourceJson(source: unknown, factoryId: string): string {
  if (!isFactoryDefinition(source)) throw new FactoryDefinitionError("factory_definition_schema_invalid");
  if ((source as FactoryDefinition).id !== factoryId) throw new FactoryDefinitionError("factory_definition_identity_mismatch");
  const text = canonicalJson(source);
  if (new TextEncoder().encode(text).byteLength > MAX_DEFINITION_BYTES) throw new FactoryDefinitionError("factory_definition_too_large");
  return text;
}

function draft(key: FactoryDefinitionKey, row: DraftRow): FactoryDraft {
  const source = JSON.parse(row.source_json) as FactoryDefinition;
  const storedRevision = Number(row.revision);
  revision(storedRevision);
  if (sourceJson(source, key.factoryId) !== row.source_json || digestObject(source) !== row.source_digest) throw new FactoryDefinitionError("factory_definition_corrupt");
  return { ...key, revision: storedRevision, sourceDigest: row.source_digest, source, archived: row.archived };
}

function published(key: FactoryDefinitionKey, row: VersionRow): FactoryVersion {
  return { ...key, version: row.version, draftRevision: Number(row.draft_revision), definitionDigest: row.definition_digest, compiledBlobDigest: row.compiled_blob_digest, compiledBytes: row.compiled_bytes };
}

function pageBounds(after: string, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || typeof after !== "string" || after.length > 512 || after.includes("\0")) throw new FactoryDefinitionError("factory_page_invalid");
}

/** Revisioned authoring and immutable publication, backed by the shared blob store. */
export class FactoryDefinitions {
  private readonly mutations: FactoryMutations;
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly blobs: BlobStore) {
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async save(principal: FactoryPrincipal, key: FactoryDefinitionKey, expectedRevision: number, idempotencyKey: string, source: unknown): Promise<FactoryDraftMetadata> {
    assertFactoryIdentity(key.projectId, key.factoryId);
    revision(expectedRevision, true);
    const snapshot = { ...key };
    const text = sourceJson(source, key.factoryId);
    const sourceDigest = digestObject(JSON.parse(text));
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.author", idempotencyKey, input: { kind: "draft.save", ...snapshot, expectedRevision, sourceDigest } }, async transaction => {
      const prior = await this.findDraft(transaction, snapshot, true);
      if (Number(prior?.revision ?? 0) !== expectedRevision || prior?.archived) throw new FactoryDefinitionError("factory_revision_conflict");
      const nextRevision = expectedRevision + 1;
      if (prior) {
        await transaction.execute(sql`UPDATE factory_drafts SET revision=${nextRevision}, source_digest=${sourceDigest}, source_json=${text}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${snapshot.projectId} AND factory_id=${snapshot.factoryId}`);
      } else {
        const inserted = rows(await transaction.execute(sql`INSERT INTO factory_drafts (tenant_id, project_id, factory_id, revision, source_digest, source_json)
          VALUES (${this.tenantId}, ${snapshot.projectId}, ${snapshot.factoryId}, ${nextRevision}, ${sourceDigest}, ${text}) ON CONFLICT DO NOTHING RETURNING factory_id`));
        if (!inserted.length) throw new FactoryDefinitionError("factory_revision_conflict");
      }
      await this.audit(transaction, principal, snapshot, "saved", { revision: nextRevision, sourceDigest });
      return { ...snapshot, revision: nextRevision, sourceDigest, archived: false };
    });
  }

  async archive(principal: FactoryPrincipal, key: FactoryDefinitionKey, expectedRevision: number, idempotencyKey: string): Promise<FactoryDraftMetadata> {
    assertFactoryIdentity(key.projectId, key.factoryId);
    revision(expectedRevision);
    const snapshot = { ...key };
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.author", idempotencyKey, input: { kind: "draft.archive", ...snapshot, expectedRevision } }, async transaction => {
      const current = draft(snapshot, await this.requireDraft(transaction, snapshot, true));
      if (current.revision !== expectedRevision || current.archived) throw new FactoryDefinitionError("factory_revision_conflict");
      const nextRevision = expectedRevision + 1;
      await transaction.execute(sql`UPDATE factory_drafts SET revision=${nextRevision}, archived=TRUE, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${snapshot.projectId} AND factory_id=${snapshot.factoryId}`);
      await this.audit(transaction, principal, snapshot, "archived", { revision: nextRevision });
      return { ...snapshot, revision: nextRevision, sourceDigest: current.sourceDigest, archived: true };
    });
  }

  read(principal: FactoryPrincipal, key: FactoryDefinitionKey): Promise<FactoryDraft> {
    const snapshot = { ...key };
    assertFactoryIdentity(key.factoryId);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, snapshot.projectId, "read");
      return draft(snapshot, await this.requireDraft(transaction, snapshot));
    });
  }

  async list(principal: FactoryPrincipal, projectId: string, after = "", limit = 50): Promise<{ items: readonly FactoryDraftMetadata[]; nextCursor: string | null }> {
    pageBounds(after, limit);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, projectId, "read");
      const selected = rows<DraftRow & { factory_id: string }>(await transaction.execute(sql`SELECT factory_id, revision, source_digest, archived FROM factory_drafts
        WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND factory_id > ${after} AND archived=FALSE ORDER BY factory_id LIMIT ${limit + 1}`));
      const items = selected.slice(0, limit).map(row => ({ projectId, factoryId: row.factory_id, revision: Number(row.revision), sourceDigest: row.source_digest, archived: row.archived }));
      return { items, nextCursor: selected.length > limit ? items[items.length - 1]!.factoryId : null };
    });
  }

  async validate(principal: FactoryPrincipal, key: FactoryDefinitionKey): Promise<CompileResult> {
    return compileFactory((await this.read(principal, key)).source);
  }

  async export(principal: FactoryPrincipal, key: FactoryDefinitionKey): Promise<{ revision: number; content: string }> {
    const current = await this.read(principal, key);
    // Canonical JSON is also the supported JSON-subset YAML export.
    return { revision: current.revision, content: canonicalJson(current.source) };
  }

  import(principal: FactoryPrincipal, key: FactoryDefinitionKey, expectedRevision: number, idempotencyKey: string, text: string, format: "json" | "yaml"): Promise<FactoryDraftMetadata> {
    if (format !== "json" && format !== "yaml") throw new FactoryDefinitionError("factory_format_invalid");
    return this.save(principal, key, expectedRevision, idempotencyKey, format === "json" ? parseFactoryJson(text) : parseFactoryYaml(text));
  }

  async listVersions(principal: FactoryPrincipal, key: FactoryDefinitionKey, after = "", limit = 50): Promise<{ items: readonly FactoryVersion[]; nextCursor: string | null }> {
    pageBounds(after, limit);
    const snapshot = { ...key };
    assertFactoryIdentity(snapshot.factoryId);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, snapshot.projectId, "read");
      const selected = rows<VersionRow>(await transaction.execute(sql`SELECT version, draft_revision, definition_digest, compiled_blob_digest, compiled_bytes FROM factory_versions
        WHERE tenant_id=${this.tenantId} AND project_id=${snapshot.projectId} AND factory_id=${snapshot.factoryId} AND version > ${after} ORDER BY version LIMIT ${limit + 1}`));
      const items = selected.slice(0, limit).map(row => published(snapshot, row));
      return { items, nextCursor: selected.length > limit ? items[items.length - 1]!.version : null };
    });
  }

  async publish(principal: FactoryPrincipal, key: FactoryDefinitionKey, expectedRevision: number, idempotencyKey: string): Promise<FactoryVersion> {
    revision(expectedRevision);
    const snapshot = { ...key };
    return this.mutations.execute({ principal, projectId: snapshot.projectId, action: "factory.publish", idempotencyKey, input: { kind: "version.publish", ...snapshot, expectedRevision } }, async transaction => {
      const current = draft(snapshot, await this.requireDraft(transaction, snapshot, true));
      if (current.revision !== expectedRevision || current.archived) throw new FactoryDefinitionError("factory_revision_conflict");
      const compiled = compileFactory(current.source);
      if (!compiled.ok) throw new FactoryDefinitionError("factory_definition_invalid", compiled.diagnostics);
      const value = compiled.factory;
      const bytes = new TextEncoder().encode(canonicalJson(value));
      if (bytes.byteLength > MAX_DEFINITION_BYTES) throw new FactoryDefinitionError("factory_definition_too_large");
      // Staging is immutable and confers no publication authority. Only the
      // scoped pointer committed below publishes the definition version.
      const compiledBlobDigest = await this.blobs.put(bytes);
      if (digestBytes(bytes) !== compiledBlobDigest) throw new FactoryDefinitionError("factory_definition_corrupt");
      const existing = await this.findVersion(transaction, snapshot, current.source.version);
      if (existing) {
        if (existing.compiled_blob_digest !== compiledBlobDigest) throw new FactoryDefinitionError("factory_version_conflict");
        return published(snapshot, existing);
      }
      await transaction.execute(sql`INSERT INTO factory_versions (tenant_id, project_id, factory_id, version, draft_revision, definition_digest, compiled_blob_digest, compiled_bytes, lock_json)
        VALUES (${this.tenantId}, ${snapshot.projectId}, ${snapshot.factoryId}, ${current.source.version}, ${expectedRevision}, ${value.digest}, ${compiledBlobDigest}, ${bytes.byteLength}, ${canonicalJson(value.lock)})`);
      await this.audit(transaction, principal, snapshot, "published", { version: current.source.version, definitionDigest: value.digest, compiledBlobDigest, draftRevision: expectedRevision });
      return { ...snapshot, version: current.source.version, draftRevision: expectedRevision, definitionDigest: value.digest, compiledBlobDigest, compiledBytes: bytes.byteLength };
    });
  }

  async readVersion(principal: FactoryPrincipal, key: FactoryDefinitionKey, version: string): Promise<{ version: FactoryVersion; compiled: CompiledFactory }> {
    assertFactoryIdentity(key.factoryId, version);
    const snapshot = { ...key };
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, snapshot.projectId, "read");
      const row = await this.findVersion(transaction, snapshot, version);
      if (!row) throw new FactoryDefinitionError("factory_version_not_found");
      const bytes = await this.blobs.get(row.compiled_blob_digest);
      if (bytes.byteLength !== row.compiled_bytes || bytes.byteLength > MAX_DEFINITION_BYTES || digestBytes(bytes) !== row.compiled_blob_digest) throw new FactoryDefinitionError("factory_definition_corrupt");
      const compiled = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CompiledFactory;
      const rebuilt = compileFactory(compiled.definition);
      if (!rebuilt.ok || rebuilt.factory.digest !== row.definition_digest || canonicalJson(rebuilt.factory) !== canonicalJson(compiled)) throw new FactoryDefinitionError("factory_definition_corrupt");
      return { version: published(snapshot, row), compiled };
    });
  }

  private async findDraft(transaction: MigrationDb, key: FactoryDefinitionKey, write = false): Promise<DraftRow | undefined> {
    return rows<DraftRow>(await transaction.execute(sql`SELECT revision, source_digest, source_json, archived FROM factory_drafts WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND factory_id=${key.factoryId} ${write ? sql`FOR UPDATE` : sql`FOR SHARE`}`))[0];
  }

  private async requireDraft(transaction: MigrationDb, key: FactoryDefinitionKey, write = false): Promise<DraftRow> {
    const row = await this.findDraft(transaction, key, write);
    if (!row) throw new FactoryDefinitionError("factory_definition_not_found");
    return row;
  }

  private async findVersion(transaction: MigrationDb, key: FactoryDefinitionKey, version: string): Promise<VersionRow | undefined> {
    return rows<VersionRow>(await transaction.execute(sql`SELECT version, draft_revision, definition_digest, compiled_blob_digest, compiled_bytes FROM factory_versions WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND factory_id=${key.factoryId} AND version=${version}`))[0];
  }

  private async audit(transaction: MigrationDb, principal: FactoryPrincipal, key: FactoryDefinitionKey, action: string, evidence: unknown): Promise<void> {
    const metadata = { tenantId: this.tenantId, ...key, principalKind: principal.kind, principalId: principal.id, evidence };
    await insertTransactionalAuditEntry(transaction, `factory-definition:${digestObject({ action, ...metadata })}`, principal.kind === "user" ? principal.id : null, `factory.definition.${action}`, key.factoryId, metadata);
  }
}
