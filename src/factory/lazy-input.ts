import { canonicalJson } from "@ezcorp/extension-contract";
import { FACTORY_LIMITS, type FactoryArtifactReference, type JsonValue } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { FactoryArtifactAccess } from "./artifact-access";
import type { FactoryArtifacts } from "./artifacts";
import { FactoryInputArtifacts, snapshotFactoryInputArtifact } from "./input-artifacts";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryRecords, assertFactoryIdentity } from "./records";

export { FACTORY_LAZY_INPUT_SCHEMA_VERSION } from "@ezcorp/factory-sdk";
export const FACTORY_LAZY_INPUT_PAGE_BYTES = FACTORY_LIMITS.maxRecordedPageBytes;
export const FACTORY_LAZY_INPUT_PAGE_ITEMS = 32;

type PathSegment = string | number;
type RunInputRow = { readonly parameters_json: string; readonly parameters_digest: string; readonly grant_revision: string | number; readonly status: string; readonly deadline_ms: string | number };

export interface FactoryLazyInputScope {
  readonly projectId: string;
  readonly runId: string;
}

export interface FactoryLazyInputValueRequest extends FactoryLazyInputScope {
  readonly name: string;
  readonly artifact: FactoryArtifactReference;
  readonly path: readonly PathSegment[];
  readonly maxBytes: number;
}

export interface FactoryLazyInputPageRequest extends FactoryLazyInputValueRequest {
  readonly cursor: number;
  readonly maxItems: number;
}

export interface FactoryLazyInputValue {
  readonly artifact: FactoryArtifactReference;
  readonly mediaType: "application/json";
  readonly storageVersion: string;
  readonly value: JsonValue;
}

export interface FactoryLazyInputPage extends Omit<FactoryLazyInputValue, "value"> {
  readonly items: readonly JsonValue[];
  readonly nextCursor: number | null;
}

export class FactoryLazyInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryLazyInputError";
  }
}

function unavailable(): never { throw new FactoryLazyInputError("factory_lazy_input_unavailable"); }
function pageRequired(): never { throw new FactoryLazyInputError("factory_lazy_input_page_required"); }
function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bytes(value: JsonValue): number { return new TextEncoder().encode(canonicalJson(value)).byteLength; }

function snapshotArtifact(value: FactoryArtifactReference): FactoryArtifactReference {
  try { return snapshotFactoryInputArtifact(value); } catch { unavailable(); }
}

function snapshotScope(value: FactoryLazyInputScope): FactoryLazyInputScope {
  assertFactoryIdentity(value.projectId, value.runId);
  return Object.freeze({ projectId: value.projectId, runId: value.runId });
}

function snapshotPath(path: readonly PathSegment[]): readonly PathSegment[] {
  if (!Array.isArray(path) || path.length > FACTORY_LIMITS.maxScopeDepth) unavailable();
  const copy = path.map(segment => {
    if (typeof segment === "string") {
      assertFactoryIdentity(segment);
      return segment;
    }
    if (!Number.isSafeInteger(segment) || segment < 0) unavailable();
    return segment;
  });
  return Object.freeze(copy);
}

function request(value: FactoryLazyInputValueRequest): FactoryLazyInputValueRequest {
  const scope = snapshotScope(value);
  if (typeof value.name !== "string") unavailable();
  assertFactoryIdentity(value.name);
  if (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > FACTORY_LAZY_INPUT_PAGE_BYTES) unavailable();
  return Object.freeze({ ...scope, name: value.name, artifact: snapshotArtifact(value.artifact), path: snapshotPath(value.path), maxBytes: value.maxBytes });
}

function pageRequest(value: FactoryLazyInputPageRequest): FactoryLazyInputPageRequest {
  const snapshot = request(value);
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 0 || !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > FACTORY_LAZY_INPUT_PAGE_ITEMS) unavailable();
  return Object.freeze({ ...snapshot, cursor: value.cursor, maxItems: value.maxItems });
}

function pathValue(root: JsonValue, path: readonly PathSegment[]): JsonValue {
  let value = root;
  for (const segment of path) {
    if (typeof segment === "string") {
      if (!isRecord(value) || !Object.hasOwn(value, segment)) unavailable();
      value = value[segment]!;
    } else {
      if (!Array.isArray(value) || segment >= value.length) unavailable();
      value = value[segment]!;
    }
  }
  return value;
}


/**
 * Host-side immutable JSON reader. It may load a 16 MiB blob, but it never
 * returns more than one bounded selected value or map page to workflow history.
 */
export class FactoryLazyInputReader {
  private readonly records: FactoryRecords;
  private readonly inputs: FactoryInputArtifacts;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, artifacts: FactoryArtifacts, access: FactoryArtifactAccess, private readonly grants: FactoryGrants, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    if (artifacts.tenantId !== tenantId || access.tenantId !== tenantId || grants.tenantId !== tenantId) throw new FactoryLazyInputError("factory_scope_mismatch");
    this.records = new FactoryRecords(database, tenantId);
    this.inputs = new FactoryInputArtifacts(artifacts, access);
  }

  readValue(input: FactoryLazyInputValueRequest): Promise<FactoryLazyInputValue> {
    let snapshot: FactoryLazyInputValueRequest;
    try { snapshot = request(input); } catch (error) { return Promise.reject(error); }
    return this.database.transaction(transaction => this.readValueInTransaction(transaction, snapshot));
  }

  async readValueInTransaction(transaction: MigrationDb, input: FactoryLazyInputValueRequest): Promise<FactoryLazyInputValue> {
    const snapshot = request(input);
    try {
      const loaded = await this.loadInTransaction(transaction, snapshot);
      const value = pathValue(loaded.value, snapshot.path);
      if (bytes(value) > snapshot.maxBytes) pageRequired();
      return { artifact: snapshot.artifact, mediaType: "application/json", storageVersion: loaded.storageVersion, value };
    } catch (error) {
      if (error instanceof FactoryLazyInputError) throw error;
      unavailable();
    }
  }

  readPage(input: FactoryLazyInputPageRequest): Promise<FactoryLazyInputPage> {
    let snapshot: FactoryLazyInputPageRequest;
    try { snapshot = pageRequest(input); } catch (error) { return Promise.reject(error); }
    return this.database.transaction(transaction => this.readPageInTransaction(transaction, snapshot));
  }

  async readPageInTransaction(transaction: MigrationDb, input: FactoryLazyInputPageRequest): Promise<FactoryLazyInputPage> {
    const snapshot = pageRequest(input);
    try {
      const loaded = await this.loadInTransaction(transaction, snapshot);
      const selected = pathValue(loaded.value, snapshot.path);
      if (!Array.isArray(selected) || snapshot.cursor > selected.length) unavailable();
      const items: JsonValue[] = [];
      let next = snapshot.cursor;
      while (next < selected.length && items.length < snapshot.maxItems) {
        const candidate = selected[next]!;
        if (bytes(candidate) > snapshot.maxBytes || bytes(items.concat([candidate])) > snapshot.maxBytes) break;
        items.push(candidate);
        next += 1;
      }
      if (items.length === 0 && next < selected.length) pageRequired();
      return { artifact: snapshot.artifact, mediaType: "application/json", storageVersion: loaded.storageVersion, items: Object.freeze(items), nextCursor: next === selected.length ? null : next };
    } catch (error) {
      if (error instanceof FactoryLazyInputError) throw error;
      unavailable();
    }
  }

  private async loadInTransaction(transaction: MigrationDb, input: FactoryLazyInputValueRequest) {
    await this.pinnedArtifactInTransaction(transaction, input);
    return this.inputs.loadInTransaction(transaction, input.projectId, input.artifact);
  }

  /** The activity may only use the exact artifact reference persisted at run admission. */
  private async pinnedArtifactInTransaction(transaction: MigrationDb, input: FactoryLazyInputValueRequest): Promise<void> {
    const row = rows<RunInputRow>(await transaction.execute(sql`SELECT parameters_json, parameters_digest, grant_revision, status, deadline_ms FROM factory_run_lifecycle
      WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND run_id=${input.runId} FOR SHARE`))[0];
    if (!row || !["queued", "running", "waiting"].includes(row.status) || !Number.isSafeInteger(Number(row.grant_revision)) || Number(row.grant_revision) < 1 || !Number.isSafeInteger(Number(row.deadline_ms)) || Number(row.deadline_ms) <= this.now()) unavailable();
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(row.parameters_json) as Record<string, unknown>;
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) unavailable();
    } catch { unavailable(); }
    if (digestObject(parameters) !== row.parameters_digest) unavailable();
    const stored = parameters[input.name];
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || (stored as { kind?: unknown }).kind !== "artifact") unavailable();
    let artifact: FactoryArtifactReference;
    try { artifact = snapshotArtifact((stored as { artifact?: FactoryArtifactReference }).artifact!); } catch { unavailable(); }
    if (artifact.artifactId !== input.artifact.artifactId || artifact.digest !== input.artifact.digest || artifact.encodedBytes !== input.artifact.encodedBytes) unavailable();
    const request = await this.records.readRunRequestInTransaction(transaction, { projectId: input.projectId, runId: input.runId });
    const kind = request.principalKind ?? "user";
    const principal: FactoryPrincipal = { kind, id: request.principalId, authentication: kind === "user" ? "api-key" : "service", ...(request.serviceCredential === undefined ? {} : { credential: request.serviceCredential }) };
    try { await this.grants.authorizeInTransaction(transaction, principal, input.projectId, "factory.run", Number(row.grant_revision)); } catch { unavailable(); }
  }
}
