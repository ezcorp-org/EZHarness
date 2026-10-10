import { encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import type { CompiledFactory, CompiledExecutionManifest, CompiledPartitionArtifact, JsonValue } from "@ezcorp/factory-sdk";
import type { FactoryDefinitionPage, FactoryDefinitionPageReference, FactoryDefinitionSource, FactoryIdentity, FactoryManifestPage, FactoryPartitionReference, ImmutableObjectReference } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { FACTORY_ARTIFACT_MAX_BYTES, FactoryArtifactError, artifactJson } from "./artifacts";
import type { FactoryArtifacts } from "./artifacts";
import type { MigrationDb } from "../db/migrations/types";

function split(content: string): readonly string[] {
  const all = new TextEncoder().encode(content);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result: string[] = [];
  for (let start = 0; start < all.byteLength;) {
    let end = Math.min(start + FACTORY_ARTIFACT_MAX_BYTES, all.byteLength);
    while (end < all.byteLength && (all[end]! & 0xc0) === 0x80) end -= 1;
    result.push(decoder.decode(all.subarray(start, end)));
    start = end;
  }
  return result;
}

type StoredManifest = Omit<FactoryManifestPage, "self">;

/** Stages canonical compiler output as page records suitable for the Node worker. */
export class FactoryDefinitionArtifacts {
  constructor(private readonly artifacts: FactoryArtifacts) {}

  async stageDefinition(compiled: CompiledFactory, identity: FactoryIdentity): Promise<FactoryDefinitionSource> {
    const snapshot = JSON.parse(JSON.stringify({ compiled, identity })) as { compiled: CompiledFactory; identity: FactoryIdentity };
    return this.artifacts.database.transaction(transaction => this.stageDefinitionInTransaction(transaction, snapshot.compiled, snapshot.identity));
  }

  /** Stages a definition after the caller has created its run in this transaction. */
  async stageDefinitionInTransaction(transaction: MigrationDb, compiled: CompiledFactory, identity: FactoryIdentity): Promise<FactoryDefinitionSource> {
    const snapshot = JSON.parse(JSON.stringify({ compiled, identity })) as { compiled: CompiledFactory; identity: FactoryIdentity };
    const content = canonicalizeJson(snapshot.compiled as unknown as JsonValue);
    const encoded = artifactJson.bytes(content);
    if (encoded.byteLength > 16 * 1024 * 1024 || !/^sha256:[0-9a-f]{64}$/.test(snapshot.compiled.digest)) throw new FactoryArtifactError("factory_definition_invalid");
    const pages = [] as Array<{ index: number; reference: ImmutableObjectReference }>;
    for (const [index, page] of split(content).entries()) {
      const reference = await this.artifacts.stageInTransaction(transaction, snapshot.identity, "definition_page", artifactJson.bytes(page), { definitionDigest: snapshot.compiled.digest, pageIndex: index, interpreterScoped: false });
      pages.push({ index, reference });
    }
    const references = pages.map(({ index, reference }) => ({ ...reference, index }));
    const manifest = await this.stageManifestChain(transaction, snapshot.identity, snapshot.compiled.digest, encoded.byteLength, references);
    return { definitionDigest: snapshot.compiled.digest, definitionEncodedBytes: encoded.byteLength, manifest };
  }

  async loadManifestPage(identity: FactoryIdentity, source: FactoryDefinitionSource, page: ImmutableObjectReference): Promise<FactoryManifestPage> {
    const loaded = await this.artifacts.load(identity, page, ["definition_manifest"]);
    const parsed = JSON.parse(artifactJson.text(loaded.content)) as StoredManifest;
    if (parsed.schemaVersion !== "factory.manifest-page.v1" || parsed.definitionDigest !== source.definitionDigest || parsed.definitionEncodedBytes !== source.definitionEncodedBytes) throw new FactoryArtifactError("factory_definition_corrupt");
    return { ...parsed, self: loaded.reference };
  }

  async loadDefinitionPage(identity: FactoryIdentity, definitionDigest: string, page: FactoryDefinitionPageReference): Promise<FactoryDefinitionPage> {
    const loaded = await this.artifacts.load(identity, page, ["definition_page"]);
    if (loaded.definitionDigest !== definitionDigest || loaded.pageIndex !== page.index) throw new FactoryArtifactError("factory_definition_not_found");
    return { index: page.index, objectId: loaded.reference.objectId, digest: loaded.reference.digest, contentBase64: encodeFactoryPageBase64(loaded.content) };
  }

  async stageExecutionManifest(value: CompiledExecutionManifest, identity: FactoryIdentity, definitionDigest: string): Promise<ImmutableObjectReference> {
    return this.artifacts.stage(identity, "execution_manifest", artifactJson.canonical(value), { definitionDigest, interpreterScoped: false });
  }

  async stagePartition(value: CompiledPartitionArtifact, identity: FactoryIdentity, definitionDigest: string): Promise<FactoryPartitionReference> {
    const reference = await this.artifacts.stage(identity, "partition", artifactJson.canonical(value), { definitionDigest, partitionId: value.id, interpreterScoped: false });
    return { ...reference, partitionId: value.id };
  }

  async loadExecutionManifest(identity: FactoryIdentity, definitionDigest: string, manifest: ImmutableObjectReference): Promise<CompiledExecutionManifest> {
    return this.loadJson(identity, definitionDigest, manifest, "execution_manifest") as Promise<CompiledExecutionManifest>;
  }

  async loadPartition(identity: FactoryIdentity, definitionDigest: string, partition: FactoryPartitionReference): Promise<CompiledPartitionArtifact> {
    return this.loadJson(identity, definitionDigest, partition, "partition").then(value => { if ((value as { id?: unknown }).id !== partition.partitionId) throw new FactoryArtifactError("factory_definition_not_found"); return value as CompiledPartitionArtifact; });
  }

  private async loadJson(identity: FactoryIdentity, definitionDigest: string, reference: ImmutableObjectReference, kind: "execution_manifest" | "partition"): Promise<unknown> {
    const loaded = await this.artifacts.load(identity, reference, [kind]);
    if (loaded.definitionDigest !== definitionDigest) throw new FactoryArtifactError("factory_definition_not_found");
    try { return JSON.parse(artifactJson.text(loaded.content)); } catch { throw new FactoryArtifactError("factory_definition_corrupt"); }
  }

  private async stageManifestChain(transaction: MigrationDb, identity: FactoryIdentity, definitionDigest: string, definitionEncodedBytes: number, references: Array<ImmutableObjectReference & { index: number }>): Promise<ImmutableObjectReference> {
    let next: ImmutableObjectReference | undefined;
    for (let end = references.length; end > 0;) {
      let start = end - 1;
      let candidate: Uint8Array | undefined;
      while (start >= 0) {
        const value: StoredManifest = { schemaVersion: "factory.manifest-page.v1", definitionDigest, definitionEncodedBytes, pages: references.slice(start, end), ...(next ? { next } : {}) };
        const encoded = artifactJson.canonical(value);
        if (encoded.byteLength > FACTORY_ARTIFACT_MAX_BYTES) { start += 1; break; }
        candidate = encoded;
        start -= 1;
      }
      if (!candidate) throw new FactoryArtifactError("factory_manifest_too_large");
      const pageStart = Math.max(0, start);
      next = await this.artifacts.stageInTransaction(transaction, identity, "definition_manifest", candidate, { definitionDigest, pageIndex: pageStart, interpreterScoped: false });
      end = pageStart;
    }
    if (!next) throw new FactoryArtifactError("factory_definition_invalid");
    return next;
  }
}
