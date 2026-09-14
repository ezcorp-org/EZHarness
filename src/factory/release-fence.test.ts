/**
 * The composition-owned release fence reader.
 *
 * The assertions that matter are the ones about what the reader does NOT do: it
 * adds no query, it invents no status, and it refuses a tenant it is not bound
 * to. A fence is the record a release is fenced against, so a reader that was
 * lenient in any of those three ways would weaken every decision that reads it.
 */
import { describe, expect, test } from "bun:test";
import type { MigrationDb } from "../db/migrations/types";
import type { FactoryRunFence } from "./run-lifecycle";
import { factoryReleaseFenceReader, FactoryReleaseFenceError, type FactoryReleaseFenceAuthority } from "./release-fence";

const TRANSACTION = { async execute() { return []; } } as unknown as MigrationDb;

function fence(overrides: Partial<FactoryRunFence> = {}): FactoryRunFence {
  return Object.freeze({
    tenantId: "tenant-01", projectId: "project-1", runId: "run-1",
    executionEpoch: 3, cancellationEpoch: 1, grantRevision: 2, revision: 5,
    deadlineAtMs: 1_900_000_000_000, definitionDigest: `sha256:${"a".repeat(64)}`,
    status: "running",
    ...overrides,
  }) as FactoryRunFence;
}

function lifecycle(answer: FactoryRunFence | Error, record?: { allowCancelling?: boolean; calls: number }): FactoryReleaseFenceAuthority {
  return {
    tenantId: "tenant-01",
    async authorizeRunInTransaction(_transaction, _key, allowCancelling) {
      if (record) { record.calls += 1; record.allowCancelling = allowCancelling; }
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("the composition-owned release fence reader", () => {
  test("refuses to compose without a tenant-scoped run lifecycle", () => {
    expect(() => factoryReleaseFenceReader(undefined as unknown as FactoryReleaseFenceAuthority)).toThrow(FactoryReleaseFenceError);
    expect(() => factoryReleaseFenceReader({ tenantId: "tenant-01" } as unknown as FactoryReleaseFenceAuthority)).toThrow("tenant-scoped run lifecycle");
    // A lifecycle with no tenant would serve every tenant's runs through one
    // reader, which is the failure this check exists for.
    expect(() => factoryReleaseFenceReader({ tenantId: "", async authorizeRunInTransaction() { return fence(); } })).toThrow(FactoryReleaseFenceError);
    expect(() => factoryReleaseFenceReader({ async authorizeRunInTransaction() { return fence(); } } as unknown as FactoryReleaseFenceAuthority)).toThrow(FactoryReleaseFenceError);
  });

  test("maps the lifecycle's fence, renaming the deadline and dropping what a release fence does not carry", async () => {
    const record = { calls: 0 };
    const reader = factoryReleaseFenceReader(lifecycle(fence(), record));

    const result = await reader.readCurrentInTransaction(TRANSACTION, "tenant-01", "project-1", "run-1");

    expect(result).toEqual({ runId: "run-1", executionEpoch: 3, cancellationEpoch: 1, status: "running", deadlineMs: 1_900_000_000_000 });
    expect(Object.isFrozen(result)).toBe(true);
    // One call, and no query of its own: the lifecycle took the four locks.
    expect(record.calls).toBe(1);
  });

  test("asks for a cancelling run rather than letting the lifecycle refuse it first", async () => {
    const record: { allowCancelling?: boolean; calls: number } = { calls: 0 };
    const reader = factoryReleaseFenceReader(lifecycle(fence({ status: "cancelling" }), record));

    const result = await reader.readCurrentInTransaction(TRANSACTION, "tenant-01", "project-1", "run-1");

    // C02 keeps a cancelling attempt's stop authority until its stop event
    // commits, so the record exists. Assurance refuses it in its own
    // vocabulary, which is more useful than a lifecycle error reaching a
    // release caller.
    expect(record.allowCancelling).toBe(true);
    expect(result.status).toBe("cancelling");
  });

  test("refuses a tenant it is not bound to, before touching the lifecycle", async () => {
    const record = { calls: 0 };
    const reader = factoryReleaseFenceReader(lifecycle(fence(), record));

    await expect(reader.readCurrentInTransaction(TRANSACTION, "tenant-02", "project-1", "run-1")).rejects.toMatchObject({ code: "factory_release_fence_scope" });
    expect(record.calls).toBe(0);
  });

  test.each([
    ["a foreign tenant", { tenantId: "tenant-02" }],
    ["a different project", { projectId: "project-2" }],
    ["a different run", { runId: "run-2" }],
  ])("refuses a lifecycle answer for %s", async (_label, overrides) => {
    const reader = factoryReleaseFenceReader(lifecycle(fence(overrides)));

    await expect(reader.readCurrentInTransaction(TRANSACTION, "tenant-01", "project-1", "run-1"))
      .rejects.toMatchObject({ code: "factory_release_fence_scope" });
  });

  test("propagates the lifecycle's typed refusal instead of inventing a terminal fence", async () => {
    const refusal = Object.assign(new Error("factory_run_stopped"), { code: "factory_run_stopped" });
    const reader = factoryReleaseFenceReader(lifecycle(refusal));

    // A terminal run must not come back as a fence this file assembled from a
    // second read of a table it does not own. Both paths refuse; only one of
    // them duplicates the lifecycle.
    await expect(reader.readCurrentInTransaction(TRANSACTION, "tenant-01", "project-1", "run-1"))
      .rejects.toMatchObject({ code: "factory_run_stopped" });
  });
});
