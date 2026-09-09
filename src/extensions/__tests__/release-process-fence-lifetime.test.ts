import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { validateManifest, type Runner } from "@ezcorp/extension-contract";
import { closeTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { domainEventSourceFixture } from "../../__tests__/helpers/domain-event-source";
import { releaseRuntimeFixture } from "../../__tests__/helpers/release-runtime";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { ReleaseProcess } from "../release-process";
import { inspectRuntimeLocks } from "../runtime-locks";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

for (const invalidation of ["token", "deadline", "kill", "grants"] as const) {
  for (const channel of ["broker", "page"] as const) test(`${invalidation} during SQL fence accounting prevents ${channel} admission`, async () => {
    const data = await domainEventSourceFixture([]);
    const manifest = validateManifest({ schemaVersion: 4, name: "fence-lifetime", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { storage: true }, pages: [{ id: "home", title: "Home" }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] });
    const snapshot = releaseRuntimeFixture(data.installationId, manifest, { ownerId: data.owner.id }).snapshot;
    const token = registerCallProvenance({ actorExtensionId: data.installationId, onBehalfOf: data.owner.id, conversationId: data.conversation.id, ownerless: false, runId: null, parentCallId: null, kind: "tool" });
    const accounting = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const reverseResult = Promise.withResolvers<unknown>();
    let armed = false;
    let effects = 0;
    let restoreClock: (() => void) | undefined;
    const now = Date.now();
    const originalTransaction = data.database.transaction.bind(data.database);
    const pausedTransaction: typeof data.database.transaction = async (callback, config) => originalTransaction(async transaction => {
      const result = await callback(transaction);
      if (armed) { armed = false; accounting.resolve(); await resume.promise; }
      return result;
    }, config);
    const transactionSpy = spyOn(data.database, "transaction").mockImplementation(pausedTransaction);
    const runner: Runner = {
      build: async () => { throw new Error("unused"); }, cancel: async () => {}, inspect: async id => ({ id, state: "running", diagnostics: [] }), collectArtifacts: async () => ({}),
      start: async (input, rpc) => ({ workerId: input.workerId, close: async () => stopped.promise, onNotification: () => () => {}, request: async method => {
        if (method === "extension/discover") return snapshot.release.manifest;
        const acquired = await rpc("ezcorp/lock.acquire", { context: input.context, input: { key: "guarded" } });
        expect(acquired).toMatchObject({ acquired: true });
        armed = true;
        try { reverseResult.resolve(await rpc(channel === "broker" ? "ezcorp/storage" : "ezcorp/page-state", { context: input.context, input: channel === "broker" ? { key: "late" } : { pageId: "home", page: {} } })); }
        catch (error) { reverseResult.resolve(error); }
        return { content: [], isError: false };
      } }),
    };
    const process = new ReleaseProcess(data.installationId, { runner: async () => runner, resolve: async () => structuredClone(snapshot) });
    process.setRequestHandler(async request => { effects++; return { jsonrpc: "2.0", id: request.id, result: {} }; });
    process.setNotificationHandler(() => { effects++; });
    try {
      const completion = process.callTool("read", {}, { ezCallId: token }).then(() => null, error => error);
      await accounting.promise;
      if (invalidation === "token") releaseCallProvenance(token);
      else if (invalidation === "kill") process.kill();
      else if (invalidation === "grants") snapshot.installation.grants = [];
      else { const clock = spyOn(Date, "now").mockReturnValue(now + 120_000); restoreClock = () => clock.mockRestore(); }
      resume.resolve();
      const response = await reverseResult.promise;
      expect(effects).toBe(0);
      expect(response).toBeInstanceOf(Error);
      stopped.resolve();
      expect(await completion).toBeInstanceOf(Error);
      expect(await inspectRuntimeLocks(data.installationId)).toHaveLength(0);
    } finally {
      restoreClock?.();
      resume.resolve();
      stopped.resolve();
      transactionSpy.mockRestore();
      process.kill();
      await process.whenCallsSettled();
      releaseCallProvenance(token);
    }
  });
}
