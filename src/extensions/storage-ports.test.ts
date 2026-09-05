import { expect, test } from "bun:test";
import { handleStorageRpc, type StorageContext, type StorageRepository } from "./storage-handler";

function fixture() {
  const rows = new Map<string, { value: unknown; encrypted: boolean; sizeBytes: number }>();
  let transactions = 0;
  const keyOf = (...parts: unknown[]) => JSON.stringify(parts);
  const repository: StorageRepository = {
    async transaction(_extensionId, operation) { transactions++; return operation(repository); },
    async get(extensionId, scope, scopeId, key) { return rows.get(keyOf(extensionId, scope, scopeId, key)) ?? null; },
    async set(extensionId, scope, scopeId, key, value, encrypted, sizeBytes) { rows.set(keyOf(extensionId, scope, scopeId, key), { value, encrypted, sizeBytes }); },
    async delete(extensionId, scope, scopeId, key) { return rows.delete(keyOf(extensionId, scope, scopeId, key)); },
    async list() { return []; },
    async usage() { return { totalBytes: [...rows.values()].reduce((sum, row) => sum + row.sizeBytes, 0), keyCount: rows.size }; },
    async conversationExtensionIds() { return ["fixture"]; },
    encrypt: (value) => `fixture:${JSON.stringify(value)}`,
    decrypt: (value) => JSON.parse(value.slice("fixture:".length)),
  };
  const context = { conversationId: "test-conversation", userId: "test-user", manifest: { schemaVersion: 4, name: "fixture", permissions: { storage: true } }, grantedPermissions: { storage: true }, repository } as unknown as StorageContext;
  const call = (params: Record<string, unknown>, ctx = context) => handleStorageRpc("fixture", { jsonrpc: "2.0", id: 1, method: "ezcorp/storage", params }, ctx);
  return { call, context, repository, rows, transactions: () => transactions };
}

test("same production storage handler uses only injected scoped repository and crypto", async () => {
  const { call, context, rows, transactions } = fixture();
  expect((await call({ action: "set", key: "secret", scope: "user", encrypted: true, value: { token: "test-only" } })).error).toBeUndefined();
  expect((await call({ action: "get", key: "secret", scope: "user" })).result).toMatchObject({ value: { token: "test-only" }, exists: true });
  expect((await call({ action: "get", key: "secret", scope: "user" }, { ...context, userId: "another-user" })).result).toMatchObject({ exists: false });
  expect((await call({ action: "set", key: "value", scope: "conversation", value: 3 })).error).toBeUndefined();
  expect((await call({ action: "delete", key: "value", scope: "conversation" })).result).toMatchObject({ deleted: true });
  expect(rows.size).toBe(1);
  expect(transactions()).toBe(3);
});

test("manifest, grant and pending PDP cannot be bypassed by repository injection", async () => {
  const { call, context, rows } = fixture();
  for (const ctx of [
    { ...context, grantedPermissions: {} },
    { ...context, manifest: { ...context.manifest, permissions: {} } },
    { ...context, engine: { authorize: async () => ({ decision: "prompt" }) } },
  ]) expect((await call({ action: "set", key: "value", value: 1 }, ctx as StorageContext)).error?.code).toBe(-32001);
  expect(rows.size).toBe(0);
});

test("scope wiring, encryption rules, quotas and missing JSON value remain enforced", async () => {
  const { call, context, repository, rows } = fixture();
  expect((await call({ action: "set", key: "secret", encrypted: true, value: 1 })).error).toBeDefined();
  expect((await call({ action: "set", key: "value" })).error).toBeDefined();
  expect((await call({ action: "set", key: "value", scope: "conversation", value: 1 }, { ...context, repository: { ...repository, conversationExtensionIds: async () => [] } })).error).toBeDefined();
  expect((await call({ action: "set", key: "value", value: "x".repeat(1024) }, { ...context, manifest: { ...context.manifest, resources: { storage: "1KB" } } })).error?.code).toBe(-32002);
  expect(rows.size).toBe(0);
});
