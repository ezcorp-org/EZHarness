import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { it } from "node:test";
import type { Payload } from "@temporalio/common";
import { defaultPayloadConverter } from "@temporalio/common";
import type { PayloadCodec } from "@temporalio/common/lib/converter/payload-codec";
import { EncryptedRecordCodec, FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, factoryTemporalPayloadWireBytes, factoryTemporalPayloadsWireBytes, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../../../src/factory/encryption.ts";
import { readFileSync } from "node:fs";
import { FACTORY_PAGE_BYTES_LIMIT } from "@ezcorp/factory-sdk/page-bytes";

/**
 * The material limits are read from their source rather than imported, because
 * `artifact-materials.ts` reaches modules Node's strip-only loader cannot
 * resolve. Reading the literals still fails this test if a limit changes.
 */
const materialSource = readFileSync(new URL("../../../../src/factory/artifact-materials.ts", import.meta.url), "utf8");
function materialLimit(name: string): number {
  const found = new RegExp(`\\b${name}:\\s*([0-9*\\s]+),`).exec(materialSource);
  assert.ok(found, `FACTORY_MATERIAL_LIMITS.${name} is missing from its source`);
  const value = found![1]!.split("*").map(part => Number(part.trim())).reduce((left, right) => left * right, 1);
  assert.ok(Number.isSafeInteger(value) && value > 0, `FACTORY_MATERIAL_LIMITS.${name} is not a whole number`);
  return value;
}
const FACTORY_MATERIAL_LIMITS = { maxChunkBytes: materialLimit("maxChunkBytes"), maxChunks: materialLimit("maxChunks"), maxTotalBytes: materialLimit("maxTotalBytes"), maxNameLength: materialLimit("maxNameLength") };
assert.match(materialSource, /FACTORY_MATERIAL_MANIFEST_MAX_BYTES = FACTORY_PAGE_BYTES_LIMIT;/);
const FACTORY_MATERIAL_MANIFEST_MAX_BYTES = FACTORY_PAGE_BYTES_LIMIT;

type TemporalProto = { readonly temporal: { readonly api: { readonly common: { readonly v1: { readonly Payload: { encode(value: unknown): { finish(): Uint8Array } }; readonly Payloads: { encode(value: unknown): { finish(): Uint8Array } } } } } } };
const proto = createRequire(import.meta.url)("../../../../node_modules/.bun/@temporalio+proto@1.23.0/node_modules/@temporalio/proto") as TemporalProto;

class Wraps implements InstallationKeyWrapStore {
  private readonly values: InstallationKeyWrap[] = [];
  async load(): Promise<readonly InstallationKeyWrap[]> { return this.values; }
  async save(value: InstallationKeyWrap): Promise<void> { this.values.push(value); }
}

function provider(id: string): StaticMasterKeyProvider { return new StaticMasterKeyProvider({ id, bytes: new Uint8Array(32).fill(id.charCodeAt(0)) }); }

it("uses the real Node Temporal PayloadCodec context for factory workflow and partition identities", async () => {
  const wraps = new Wraps();
  const key = await InstallationDataKey.loadOrCreate("install", wraps, provider("old"));
  const codec: PayloadCodec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(key, "history"), "tenant");
  const context = { type: "workflow" as const, namespace: "factory-tenant", workflowId: `tenant/logical-run-${"x".repeat(300)}` };
  const payload: Payload = defaultPayloadConverter.toPayload({ approved: true, nested: [1, 2] }, context);
  const encoded = await codec.encode([payload], context);
  assert.notDeepEqual(encoded[0]!.data, payload.data);
  const decoded = (await codec.decode(encoded, context))[0]!;
  assert.deepEqual(decoded.metadata, payload.metadata);
  assert.deepEqual(defaultPayloadConverter.fromPayload(decoded, context), { approved: true, nested: [1, 2] });
  const partition = { ...context, workflowId: `${context.workflowId}/partitions/interpreter-7` };
  assert.deepEqual(defaultPayloadConverter.fromPayload((await codec.decode(await codec.encode([payload], partition), partition))[0]!, partition), { approved: true, nested: [1, 2] });
  await assert.rejects(() => codec.decode(encoded, partition), { code: "factory_decryption_failed" });
  await assert.rejects(() => codec.decode([{ ...encoded[0]!, data: createHash("sha256").update(encoded[0]!.data!).digest() }], context), { code: "factory_decryption_failed" });
  const rotated = await key.rotate(wraps, provider("new"));
  const rewrapped: PayloadCodec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(rotated, "history"), "tenant");
  assert.deepEqual(defaultPayloadConverter.fromPayload((await rewrapped.decode(encoded, context))[0]!, context), { approved: true, nested: [1, 2] });
});

it("measures the actual Temporal protobuf boundary after codec encryption", async () => {
  const key = await InstallationDataKey.loadOrCreate("install", new Wraps(), provider("old"));
  const codec: PayloadCodec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(key, "history"), "tenant");
  const context = { type: "workflow" as const, namespace: "factory-tenant", workflowId: "tenant/logical-run" };
  const metadata = { encoding: Buffer.from("json/plain") };
  let lower = 0, upper = FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const encoded = await codec.encode([{ metadata, data: new Uint8Array(candidate) }], context).catch(() => undefined);
    if (encoded) lower = candidate;
    else upper = candidate - 1;
  }
  const input = { metadata, data: new Uint8Array(lower) };
  const encoded = await codec.encode([input], context);
  assert.equal(factoryTemporalPayloadWireBytes(input), proto.temporal.api.common.v1.Payload.encode(encoded[0]).finish().byteLength);
  assert.equal(factoryTemporalPayloadsWireBytes([input]), proto.temporal.api.common.v1.Payloads.encode({ payloads: encoded }).finish().byteLength);
  assert.equal(proto.temporal.api.common.v1.Payloads.encode({ payloads: encoded }).finish().byteLength, FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT);
  await assert.rejects(() => codec.encode([{ metadata, data: new Uint8Array(lower + 1) }], context), { code: "factory_payload_too_large" });
});

it("carries a 256 MiB material by reference inside the C08 encoded argument limit", async () => {
  const key = await InstallationDataKey.loadOrCreate("install", new Wraps(), provider("old"));
  const codec: PayloadCodec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(key, "history"), "tenant");
  const context = { type: "workflow" as const, namespace: "factory-tenant", workflowId: "tenant/logical-run" };

  // The reference a sealed material issues names its bounded manifest, never its bytes.
  const material = {
    schemaVersion: "factory.material.v1",
    tenantId: "tenant", projectId: "project", runId: "logical-run",
    attemptId: `attempt-${"a".repeat(64)}`, operationId: "logical-run:node-a:0:0",
    objectName: `workspace/${"nested/".repeat(60)}checkpoint.tar`,
    version: 1, mediaType: "application/octet-stream",
    digest: `sha256:${"b".repeat(64)}`,
    totalBytes: FACTORY_MATERIAL_LIMITS.maxTotalBytes,
    chunkCount: FACTORY_MATERIAL_LIMITS.maxChunks,
    artifact: { artifactId: `factory-artifact-${"c".repeat(36)}`, digest: `sha256:${"d".repeat(64)}`, encodedBytes: FACTORY_MATERIAL_MANIFEST_MAX_BYTES },
  };
  assert.equal(material.objectName.length <= FACTORY_MATERIAL_LIMITS.maxNameLength, true);
  assert.equal(material.totalBytes, 256 * 1024 * 1024);

  const payload: Payload = defaultPayloadConverter.toPayload(material, context)!;
  const encoded = await codec.encode([payload], context);
  const wire = proto.temporal.api.common.v1.Payloads.encode({ payloads: encoded }).finish().byteLength;
  assert.equal(wire, factoryTemporalPayloadsWireBytes([payload]));
  assert.ok(wire < FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT, `material reference encodes to ${wire} bytes`);
  assert.deepEqual(defaultPayloadConverter.fromPayload(await codec.decode(encoded, context).then(values => values[0]!), context), material);

  // The bytes themselves never fit, which is why they move over the gateway.
  const inline = { ...material, contentBase64: "A".repeat(FACTORY_MATERIAL_LIMITS.maxChunkBytes) };
  await assert.rejects(() => codec.encode([defaultPayloadConverter.toPayload(inline, context)!], context), { code: "factory_payload_too_large" });
});
