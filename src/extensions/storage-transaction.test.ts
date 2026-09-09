import { afterAll, beforeEach, expect, test } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "../__tests__/helpers/test-pglite";
import type { StorageContext } from "./storage-handler";

mockDbConnection();
const { createExtension } = await import("../db/queries/extensions");
const { handleStorageRpc, productionStorageRepository } = await import("./storage-handler");
const { getStorageUsage, getStorageValue } = await import("../db/queries/extension-storage");
const extensionId = "storage-transaction-fixture";
const context = { userId: "owner", conversationId: "conversation", manifest: { schemaVersion: 4, name: "fixture", permissions: { storage: true }, resources: { storage: "1KB" } }, grantedPermissions: { storage: true } } as unknown as StorageContext;

beforeEach(async () => {
  await setupTestDb();
  await createExtension({ id: extensionId, name: "fixture", version: "1.0.0", source: "release-v4", manifest: context.manifest });
});
afterAll(closeTestDb);

test("concurrent writes cannot both pass the same quota snapshot", async () => {
  const results = await Promise.all(["first", "second"].map((key) => handleStorageRpc(extensionId, { jsonrpc: "2.0", id: key, method: "ezcorp/storage", params: { action: "set", key, value: "x".repeat(600) } }, context)));
  expect(results.filter((result) => !result.error)).toHaveLength(1);
  expect(results.filter((result) => result.error?.code === -32002)).toHaveLength(1);
  expect((await getStorageUsage(extensionId)).totalBytes).toBe(602);
});

test("repository transaction rollback removes partial mutations", async () => {
  await expect(productionStorageRepository.transaction(extensionId, async (repository) => {
    await repository.set(extensionId, "global", null, "partial", { value: "never committed" }, false, 20);
    throw new Error("injected fault");
  })).rejects.toThrow("injected fault");
  expect(await getStorageValue(extensionId, "global", null, "partial")).toBeNull();
});
