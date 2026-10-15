/**
 * W09e: which cancels the release stop owns, and what it hands back to the task stop.
 * The stores are real on PGlite and PostgreSQL in the lifecycle suite; here each branch is driven directly.
 */
import { expect, test } from "bun:test";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import { FactoryReleaseStops } from "./release-stops";

const service = { tenantId: "tenant-a", subject: "orchestration" };
const reference = { tenantId: "tenant-a", projectId: "project-a", logicalRunId: "run-a", interpreterId: "root", commandId: "cancel-1" };

/** A database whose recorded-event lookup answers `recorded`. */
function database(recorded?: KernelEvent): TransactionalDb {
  const transaction = { execute: async () => ({ rows: recorded ? [{ payload: JSON.stringify(recorded) }] : [] }) };
  return { transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transaction) } as unknown as TransactionalDb;
}

function world(options: { recorded?: KernelEvent; kind?: string; operationId?: string; fail?: unknown }) {
  const enqueued: KernelEvent[] = [];
  const authority = {
    tenantId: "tenant-a",
    async withCurrentCancellation(_service: unknown, _reference: unknown, work: (tx: unknown, context: unknown) => Promise<unknown>) {
      if (options.fail !== undefined) throw options.fail;
      return work({}, {
        node: { kind: options.kind ?? "release" }, fence: { cancellationEpoch: 1 }, state: { nowMs: 5 },
        attempt: { commandId: "request-release-1" },
        command: { kind: "cancel-node", id: "cancel-1", nodeId: "release", candidateGeneration: 0, attempt: 1, attemptCommandId: "request-release-1", cancellationEpoch: 1 },
      });
    },
  } as unknown as FactoryCommandAuthority;
  const inbox = { tenantId: "tenant-a", async enqueueInTransaction(_tx: unknown, _key: unknown, event: KernelEvent) { enqueued.push(event); } } as unknown as FactoryInbox;
  const releases = { async stopInTransaction(_tx: unknown, _project: string, _operation: string, _stop: unknown, event: (effect: "uncertain") => KernelEvent) { return event("uncertain"); } };
  const effects = { async releaseOperationIdInTransaction() { return options.operationId; } };
  return { stops: new FactoryReleaseStops(database(options.recorded), authority, inbox, releases, effects, () => 10), enqueued };
}

test("a release with no prepared operation stops certainly, with no effect, and the event is enqueued", async () => {
  const { stops, enqueued } = world({});
  const event = await stops.stop(service, reference);
  expect(event).toEqual({ kind: "attempt-stopped", id: "cancel-1:stopped", atMs: 10, nodeId: "release", commandId: "request-release-1", candidateGeneration: 0, attempt: 1 });
  expect(enqueued).toEqual([event!]);
});

test("a prepared operation's stop names the effect its store found", async () => {
  const { stops, enqueued } = world({ operationId: "operation-1" });
  expect(await stops.stop(service, reference)).toMatchObject({ uncertain: false, effect: "uncertain" });
  expect(enqueued).toHaveLength(1);
});

test("a repeated cancel returns the event recorded the first time and enqueues nothing", async () => {
  const recorded = { kind: "attempt-stopped", id: "cancel-1:stopped", atMs: 3, nodeId: "release", commandId: "request-release-1", candidateGeneration: 0, attempt: 1 } as KernelEvent;
  const { stops, enqueued } = world({ recorded });
  expect(await stops.stop(service, reference)).toEqual(recorded);
  expect(enqueued).toEqual([]);
});

test("a task node's cancel, and a cancel that is no longer current, are the task stop's", async () => {
  expect(await world({ kind: "task" }).stops.stop(service, reference)).toBeUndefined();
  expect(await world({ fail: Object.assign(new Error("stale"), { code: "factory_command_stale" }) }).stops.stop(service, reference)).toBeUndefined();
  await expect(world({ fail: Object.assign(new Error("scope"), { code: "factory_command_scope" }) }).stops.stop(service, reference)).rejects.toMatchObject({ code: "factory_command_scope" });
  await expect(world({ fail: null }).stops.stop(service, reference)).rejects.toBeNull();
});

test("the release stop refuses an inbox of another tenant", () => {
  const authority = { tenantId: "tenant-a" } as unknown as FactoryCommandAuthority;
  const inbox = { tenantId: "tenant-b" } as unknown as FactoryInbox;
  expect(() => new FactoryReleaseStops(database(), authority, inbox, {} as never, {} as never)).toThrow("factory_release_stop_scope");
});
