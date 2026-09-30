/**
 * The dispatch preflight.
 *
 * The assertions that matter are the ones about where each field came from. A
 * lease that fenced the wrong allocation would let two workers believe they
 * hold the same capacity, so every field must be traceable to the record the
 * admission ledger already holds, and the one field that is not a copy must be
 * refused in the case where a default would be wrong.
 */
import { describe, expect, test } from "bun:test";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { FactoryAttemptPreflightError, factoryAttemptPreflight, type FactoryAttemptPreflightOptions } from "./attempt-preflight";

const REQUEST = {
  authority: { attemptId: "attempt-1", tenantId: "tenant-01", projectId: "project-1", runId: "run-1" },
} as unknown as FactoryRunnerRequest;

function database(): TransactionalDb {
  const execute = async () => [];
  return { execute, async transaction<R>(work: (t: MigrationDb) => Promise<R>) { return work({ execute } as unknown as MigrationDb); } } as unknown as TransactionalDb;
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: "factory-reservation:abc", tenantId: "tenant-01", grantRevision: 4,
    allocationGeneration: 2, holderGeneration: 3, allocationToken: "token-1",
    fence: "fence-1", deadlineAt: new Date(1_900_000_000_000), resources: { cpu: 1 },
    ...overrides,
  };
}

function preflight(overrides: Partial<FactoryAttemptPreflightOptions> = {}, leaseValue = lease()) {
  return factoryAttemptPreflight({
    database: database(),
    queue: { readInTransaction: async () => ({ reference: { reservationId: "factory-reservation:abc" } }) } as never,
    admissions: { readRetainedAdmittedInTransaction: async () => ({ request: {}, receipt: { lease: leaseValue } }) } as never,
    readiness: { assertDispatchReady: async () => ({ receiptDigest: "sha256:ready" }) } as never,
    hostId: "host-configured",
    ...overrides,
  });
}

describe("the dispatch preflight", () => {
  test("refuses to compose without this installation's host", () => {
    expect(() => preflight({ hostId: "" })).toThrow(FactoryAttemptPreflightError);
    expect(() => preflight({ hostId: undefined as unknown as string })).toThrow("host id");
  });

  test("maps the admitted pool lease field for field", async () => {
    const mapped = await preflight().lease(REQUEST);

    // Every field is the ledger's, not this file's.
    expect(mapped).toEqual({
      reservationId: "factory-reservation:abc", grantRevision: 4,
      allocationGeneration: 2, holderGeneration: 3, allocationToken: "token-1",
      hostId: "host-configured",
    });
    expect(Object.isFrozen(mapped)).toBe(true);
  });

  test("reads the reservation the queue recorded, and asks the ledger for exactly that one", async () => {
    const asked: Array<{ projectId: string; runId: string; reservationId: string }> = [];
    const mapped = await preflight({
      queue: { readInTransaction: async () => ({ reference: { reservationId: "factory-reservation:zzz" } }) } as never,
      admissions: {
        async readRetainedAdmittedInTransaction(_t: MigrationDb, key: { projectId: string; runId: string; reservationId: string }) {
          asked.push(key);
          return { request: {}, receipt: { lease: lease({ reservationId: "factory-reservation:zzz" }) } };
        },
      } as never,
    }).lease(REQUEST);

    // Never derived: a reservation id is a digest of the run scope and node
    // identity, and a second derivation that drifted would fence the wrong
    // allocation.
    expect(asked).toEqual([{ projectId: "project-1", runId: "run-1", reservationId: "factory-reservation:zzz" }]);
    expect(mapped.reservationId).toBe("factory-reservation:zzz");
  });

  test("a pinned host wins over the configured one", async () => {
    const mapped = await preflight({}, lease({ hostId: "host-gpu-7", resources: { "gpu-host": 1 } })).lease(REQUEST);
    expect(mapped.hostId).toBe("host-gpu-7");
  });

  test("a GPU allocation with no pinned host is refused, not defaulted", async () => {
    // Falling back to the configured host here would dispatch to a machine
    // that does not hold the card.
    await expect(preflight({}, lease({ resources: { "gpu-host": 1 } })).lease(REQUEST))
      .rejects.toMatchObject({ code: "factory_preflight_host_missing" });
  });

  test.each([
    ["a resource vector with no gpu entry", { cpu: 2 }],
    ["a gpu entry of zero", { "gpu-host": 0 }],
    ["a missing resource vector", undefined],
    ["a non-numeric gpu entry", { "gpu-host": "one" }],
  ])("%s is a CPU allocation, so the configured host applies", async (_label, resources) => {
    const mapped = await preflight({}, lease({ resources })).lease(REQUEST);
    expect(mapped.hostId).toBe("host-configured");
  });

  test("an attempt with no queue record is refused by name", async () => {
    await expect(preflight({ queue: { readInTransaction: async () => null } as never }).lease(REQUEST))
      .rejects.toMatchObject({ code: "factory_preflight_not_queued" });
  });

  test("a ledger answer for another reservation is refused", async () => {
    await expect(preflight({}, lease({ reservationId: "factory-reservation:other" })).lease(REQUEST))
      .rejects.toMatchObject({ code: "factory_preflight_not_admitted" });
  });

  test("the prepared package is the readiness answer, unchanged", async () => {
    const asked: unknown[] = [];
    const receipt = await preflight({
      readiness: { assertDispatchReady: async (request: unknown) => { asked.push(request); return { receiptDigest: "sha256:exact" }; } } as never,
    }).preparedPackage(REQUEST);

    expect(receipt).toEqual({ receiptDigest: "sha256:exact" } as never);
    expect(asked).toEqual([REQUEST]);
  });
});

describe("the held allocation's devices (W02d R3)", () => {
  const request = REQUEST;
  const gpuLease = (profile?: unknown) => lease({ resources: { cpu: 1, "gpu-host": 1 }, hostId: "gpu-host-1", ...(profile === undefined ? {} : { deviceProfile: profile }) });
  const mapped = { reservationId: "factory-reservation:abc", grantRevision: 4, allocationGeneration: 2, holderGeneration: 3, allocationToken: "token-1", hostId: "gpu-host-1" };

  test("a CPU lease gives the empty grant", async () => {
    const cpu = preflight();
    const held = await cpu.lease(request);
    expect(await cpu.devices!(request, held)).toEqual({ devices: [], cdiDevices: [], gpuHosts: 0 });
  });

  test("a gpu-host lease gives exactly the devices its recorded profile names for its own host", async () => {
    const profile = { hostId: "gpu-host-1", devices: ["/dev/dri/renderD128"], cdiDevices: [], tier: "trusted-local" };
    expect(await preflight({}, gpuLease(profile)).devices!(request, mapped)).toEqual({ devices: ["/dev/dri/renderD128"], cdiDevices: [], gpuHosts: 1 });
  });

  test("a gpu-host lease with no recorded profile, or a profile for another host, is refused by name before any launch", async () => {
    for (const profile of [undefined, { hostId: "gpu-host-2", devices: ["/dev/dri/renderD128"], cdiDevices: [], tier: "trusted-local" }]) {
      const refused = await preflight({}, gpuLease(profile)).devices!(request, mapped).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(FactoryAttemptPreflightError);
      expect((refused as FactoryAttemptPreflightError).code).toBe("factory_preflight_device_profile_missing");
    }
  });

  test("the devices are read from the same recorded admission as the lease, and never from the pool", async () => {
    const asked: string[] = [];
    const reading = preflight({
      queue: { readInTransaction: async () => { asked.push("queue"); return { reference: { reservationId: "factory-reservation:abc" } }; } } as never,
      admissions: { readRetainedAdmittedInTransaction: async () => { asked.push("admission"); return { request: {}, receipt: { lease: lease() } }; } } as never,
    });
    await reading.devices!(request, { ...mapped, hostId: "host-configured" });
    expect(asked).toEqual(["queue", "admission"]);
    await expect(preflight({ queue: { readInTransaction: async () => undefined } as never }).devices!(request, mapped)).rejects.toMatchObject({ code: "factory_preflight_not_queued" });
  });
});
