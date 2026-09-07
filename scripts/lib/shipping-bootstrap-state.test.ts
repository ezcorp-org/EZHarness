import { expect, spyOn, test } from "bun:test";
import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { BundledBootstrapTimeoutError, requireBundledBootstrapVerified, waitForBundledBootstrap } from "./shipping-bootstrap-state";

function state(
  status: "queued" | "building" | "verified" | "failed",
  metadata: { lease?: { fence: number; until: number }; events?: Array<{ sequence: number; state: string; at: string }> } = {},
) {
  return {
    operations: {
      build: {
        id: "build",
        kind: "build",
        state: status,
        diagnostics: [],
        events: metadata.events ?? [],
        updatedAt: "2026-09-07T00:00:00.000Z",
        ...(metadata.lease ? { lease: metadata.lease } : {}),
      },
    },
  };
}

test("waits for observed bundled work to become terminal and retains its receipt", async () => {
  let polls = 0;
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  const client = {
    async listExtensions() { polls += 1; return []; },
    async extensionControl() { return state(polls === 1 ? "queued" : "verified"); },
  } as unknown as HarnessClient;
  try {
    const result = await waitForBundledBootstrap(client);
    expect(result).toMatchObject({ bootstrapInstallations: resolveBundledExtensions().length, initialPending: resolveBundledExtensions().length, maximumPending: resolveBundledExtensions().length, terminalOperationStates: { verified: resolveBundledExtensions().length } });
    requireBundledBootstrapVerified(result, "test recovery");
  } finally { sleep.mockRestore(); }
});

test("allows a missed pending transition only when explicitly requested", async () => {
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  const client = { async listExtensions() { return []; }, async extensionControl() { return state("verified"); } } as unknown as HarnessClient;
  try {
    const result = await waitForBundledBootstrap(client, { requireObservedPending: false });
    expect(result.initialPending).toBe(0);
    requireBundledBootstrapVerified(result, "post-restart");
  } finally { sleep.mockRestore(); }
});

test("rejects ambiguous installation mapping and failed bundled builds", async () => {
  const names = resolveBundledExtensions().map(({ name }) => ({ id: "same", name }));
  const duplicate = { async listExtensions() { return names; }, async extensionControl() { return state("verified"); } } as unknown as HarnessClient;
  await expect(waitForBundledBootstrap(duplicate, { requireObservedPending: false })).rejects.toThrow("not unique");
  expect(() => requireBundledBootstrapVerified({ bootstrapInstallations: 1, initialPending: 1, maximumPending: 1, terminalOperationStates: { failed: 1 }, terminalOperations: [{ name: "failed", installationId: "failed", operations: [{ id: "build", kind: "build", state: "failed", diagnostics: [] }] }] }, "failed recovery")).toThrow("did not verify");
  expect(() => requireBundledBootstrapVerified({ bootstrapInstallations: 2, initialPending: 1, maximumPending: 1, terminalOperationStates: { verified: 2 }, terminalOperations: [{ name: "duplicate", installationId: "one", operations: [{ id: "one", kind: "build", state: "verified", diagnostics: [] }, { id: "two", kind: "build", state: "verified", diagnostics: [] }] }, { name: "missing", installationId: "two", operations: [] }] }, "missing installation")).toThrow("did not verify");
});

test("reports no snapshot when the bounded bootstrap observer has no poll", async () => {
  const client = { async listExtensions() { throw new Error("must not poll"); }, async extensionControl() { throw new Error("must not inspect"); } } as unknown as HarnessClient;
  await expect(waitForBundledBootstrap(client, { deadlineMs: -1 })).rejects.toMatchObject({
    name: "BundledBootstrapTimeoutError",
    snapshot: null,
    observer: { deadlineMs: -1 },
  } satisfies Partial<BundledBootstrapTimeoutError>);
});

test("reports the final pending operations in a bounded bootstrap timeout", async () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { now += 1; });
  const client = {
    async listExtensions() { return []; },
    async extensionControl() {
      return state("queued", {
        lease: { fence: 2, until: 60_001 },
        events: [{ sequence: 1, state: "building", at: "2026-09-07T00:00:00.000Z" }],
      });
    },
  } as unknown as HarnessClient;
  try {
    let timeout: BundledBootstrapTimeoutError | undefined;
    try {
      await waitForBundledBootstrap(client, { deadlineMs: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(BundledBootstrapTimeoutError);
      timeout = error as BundledBootstrapTimeoutError;
    }
    expect(timeout?.snapshot).toMatchObject({
      capturedAt: expect.any(String),
      observer: { deadlineMs: 1 },
      bootstrapInstallations: resolveBundledExtensions().length,
      initialPending: resolveBundledExtensions().length,
      maximumPending: resolveBundledExtensions().length,
      terminalOperationStates: { queued: resolveBundledExtensions().length },
    });
    expect(timeout?.snapshot?.terminalOperations[0]?.operations[0]).toMatchObject({
      lease: { fence: 2, until: 60_001 },
      lastEvent: { state: "building", at: "2026-09-07T00:00:00.000Z" },
    });
  } finally {
    sleep.mockRestore();
    clock.mockRestore();
  }
});

test("allows an R2 observer to finish after a six-minute lease and two idle polls", async () => {
  let now = 0;
  let polls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let sleeps = 0;
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { now = 360_001 + sleeps; sleeps += 1; });
  const client = {
    async listExtensions() { polls += 1; return []; },
    async extensionControl() { return state(polls === 1 ? "building" : "verified"); },
  } as unknown as HarnessClient;
  try {
    const result = await waitForBundledBootstrap(client, { requireObservedPending: false, deadlineMs: 480_000 });
    expect(result).toMatchObject({
      observer: { deadlineMs: 480_000 },
      initialPending: resolveBundledExtensions().length,
      terminalOperationStates: { verified: resolveBundledExtensions().length },
    });
    requireBundledBootstrapVerified(result, "after a recovered lease");
    expect(polls).toBe(3);
    expect(sleeps).toBe(2);
  } finally {
    sleep.mockRestore();
    clock.mockRestore();
  }
});
