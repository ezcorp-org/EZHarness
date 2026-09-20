import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProviderCall } from "@ezcorp/extension-contract";
import { DurableOperationJournal } from "../runtime/sandbox/local-podman/journal";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
const call = (digest = "a".repeat(64)): ProviderCall => ({ scope: { projectId: "p", bindingId: "b", generation: 1 }, operationId: "op", idempotencyKey: "key", requestDigest: digest });
describe("durable local operation journal", () => {
  test("publishes pending and recovers it as unknown without replay", async () => { root = await mkdtemp(`${tmpdir()}/ez-journal-`); const journal = new DurableOperationJournal(root); expect(await journal.begin(call())).toEqual({ kind: "new" }); expect((await journal.begin(call())).kind).toBe("unknown"); });
  test("replays the exact completed result", async () => { root = await mkdtemp(`${tmpdir()}/ez-journal-`); const journal = new DurableOperationJournal(root); await journal.begin(call()); const result = { receipt: { operationId: "op", idempotencyKey: "key", requestDigest: "a".repeat(64), outcome: "succeeded" } }; await journal.complete(call(), result); expect(await journal.begin(call())).toEqual({ kind: "replay", result }); });
  test("rejects payload and operation collisions", async () => { root = await mkdtemp(`${tmpdir()}/ez-journal-`); const journal = new DurableOperationJournal(root); await journal.begin(call()); await expect(journal.begin(call("b".repeat(64)))).rejects.toThrow("conflicts"); await expect(journal.begin({ ...call(), operationId: "other" })).rejects.toThrow("conflicts"); });
  test("scopes equal keys independently", async () => { root = await mkdtemp(`${tmpdir()}/ez-journal-`); const journal = new DurableOperationJournal(root); expect((await journal.begin(call())).kind).toBe("new"); expect((await journal.begin({ ...call(), scope: { ...call().scope, projectId: "other" } })).kind).toBe("new"); });
});
