/**
 * The two refusals a real run cannot produce on demand.
 *
 * The lifecycle suite proves delivery against real PostgreSQL: a settled
 * operation, a crash between settlement and delivery, a race, an uncertain
 * operation, a failed one, and a foreign tenant. What it cannot stage without
 * doctoring durable rows is a settled operation whose command reader finds
 * nothing, or a receipt the Release node's own port refuses. Both are named
 * refusals, and neither may reach the inbox.
 */
import { describe, expect, test } from "bun:test";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { FACTORY_RELEASE_OUTCOME_SCAN_LIMIT, FactoryReleaseOutcomeDelivery, factoryReleaseOutcomeEventId } from "./release-outcome-delivery";

const SERVICE = { tenantId: "tenant-1", subject: "orchestration" };
const REFERENCE = { tenantId: "tenant-1", projectId: "project-1", logicalRunId: "run-1", interpreterId: "root", commandId: "run-1:release:request-release:4" };

/** A database that answers every read with the rows the case names. */
function database(answers: unknown[][]): TransactionalDb {
  const execute = async () => answers.shift() ?? [];
  const handle = { execute } as unknown as MigrationDb;
  return { execute, transaction: async <T>(work: (transaction: MigrationDb) => Promise<T>) => work(handle) } as unknown as TransactionalDb;
}

const settled = (over: Record<string, unknown> = {}) => ({ run_id: "run-1", state: "succeeded", request_digest: `sha256:${"a".repeat(64)}`, receipt_json: JSON.stringify({ version: "v1" }), outcome_code: "confirmed", stop_command_id: null, settled_at_ms: "1700000000000", ...over });

function delivery(rows: unknown[][], options: { command?: typeof REFERENCE; port?: Record<string, unknown> } = {}) {
  const enqueued: unknown[] = [];
  const value = new FactoryReleaseOutcomeDelivery({
    database: database(rows), tenantId: "tenant-1", service: SERVICE,
    effects: { async readReleaseCommandInTransaction() { return options.command; } },
    authority: {
      async withCurrentReleaseInTransaction(transaction, _service, _reference, work) {
        const node = { id: "release", kind: "release", outputPorts: options.port ?? { receipt: { type: "object" } } };
        return work(transaction, { command: { id: REFERENCE.commandId, nodeId: "release", candidateGeneration: 0 }, attempt: { attempt: 1 }, node } as never);
      },
    },
    inbox: { async enqueueInTransaction(_transaction, key, event) { enqueued.push({ key, event }); return {} as never; } },
  });
  return { value, enqueued };
}

describe("FactoryReleaseOutcomeDelivery", () => {
  test("a settled operation whose command no verified receipt names is refused, and nothing is enqueued", async () => {
    const { value, enqueued } = delivery([[settled()]]);
    await expect(value.deliver("project-1", "op-1")).rejects.toMatchObject({ code: "factory_release_outcome_command_missing" });
    expect(enqueued).toEqual([]);
  });

  test("a stopped release's late outcome is refused for the node by name, and nothing is enqueued (W09e R4)", async () => {
    const { value, enqueued } = delivery([[settled({ stop_command_id: "cancel-1" })]], { command: REFERENCE });
    await expect(value.deliver("project-1", "op-1")).rejects.toMatchObject({ code: "factory_release_stopped" });
    expect(enqueued).toEqual([]);
  });

  test("a receipt the Release node's port refuses is not an answer", async () => {
    const { value, enqueued } = delivery([[settled({ receipt_json: JSON.stringify("not a record") })]], { command: REFERENCE, port: { receipt: { type: "object" } } });
    await expect(value.deliver("project-1", "op-1")).rejects.toMatchObject({ code: "factory_release_outcome_invalid" });
    expect(enqueued).toEqual([]);
  });

  test("the event is built from the settled row alone, so every retry is the same bytes", async () => {
    const first = delivery([[settled()]], { command: REFERENCE });
    const second = delivery([[settled()]], { command: REFERENCE });
    const [a, b] = [await first.value.deliver("project-1", "op-1"), await second.value.deliver("project-1", "op-1")];
    expect(a).toEqual(b);
    expect(a).toEqual({ kind: "node-result", id: factoryReleaseOutcomeEventId("op-1"), atMs: 1_700_000_000_000, nodeId: "release", commandId: REFERENCE.commandId, candidateGeneration: 0, attempt: 1, output: { receipt: { version: "v1" } } });
    expect(first.enqueued).toEqual([{ key: { projectId: "project-1", runId: "run-1", interpreterId: "root" }, event: a }]);
  });

  test("a failed operation without an outcome code still fails by a stable name", async () => {
    const { value } = delivery([[settled({ state: "failed", outcome_code: null })]], { command: REFERENCE });
    expect(await value.deliver("project-1", "op-1")).toMatchObject({ kind: "node-failed", error: "factory_release_failed", failureKind: "execution" });
  });

  test("the scan is bounded, and an identity it cannot trust is refused before any read", async () => {
    const reads: unknown[] = [];
    const recording = { execute: async (query: unknown) => { reads.push(query); return [{ project_id: "project-1", operation_id: "op-1" }]; }, transaction: async () => undefined } as unknown as TransactionalDb;
    const scanning = new FactoryReleaseOutcomeDelivery({ database: recording, tenantId: "tenant-1", service: SERVICE, effects: {} as never, authority: {} as never, inbox: {} as never });
    expect(await scanning.undelivered()).toEqual([{ projectId: "project-1", operationId: "op-1" }]);
    expect(FACTORY_RELEASE_OUTCOME_SCAN_LIMIT).toBe(16);
    const { value } = delivery([]);
    await expect(value.deliver("", "op-1")).rejects.toThrow();
    expect(() => new FactoryReleaseOutcomeDelivery({ database: recording, tenantId: "", service: SERVICE, effects: {} as never, authority: {} as never, inbox: {} as never })).toThrow();
  });
});
