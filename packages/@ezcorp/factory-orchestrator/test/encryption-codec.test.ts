import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import type { Payload } from "@temporalio/common";
import { defaultPayloadConverter } from "@temporalio/common";
import type { PayloadCodec } from "@temporalio/common/lib/converter/payload-codec";
import { EncryptedRecordCodec, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../../../src/factory/encryption.ts";

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
