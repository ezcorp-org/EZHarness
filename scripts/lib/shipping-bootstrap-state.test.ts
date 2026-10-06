import { expect, spyOn, test } from "bun:test";
import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { bundledInstallationId } from "../../src/extensions/bundled-bootstrap";
import { BUNDLED_BOOTSTRAP_POLICY, bundledBootstrapSafetyNetMs } from "./bundled-bootstrap-progress";
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

const BUNDLED = resolveBundledExtensions().map(({ name }) => name);

/** A fake clock the waiter reads; each of its one-second sleeps advances it by `stepMs`. */
function fakeClock(stepMs = 1_000) {
  const clock = { now: 0, sleeps: 0 };
  return { clock, options: { now: () => clock.now, sleep: async (ms: number) => { expect(ms).toBe(1_000); clock.sleeps += 1; clock.now += stepMs; } } };
}

function timed(status: "queued" | "building" | "verified", updatedAtMs: number, lease?: { fence: number; until: number }) {
  const value = state(status, lease ? { lease } : {});
  value.operations.build.updatedAt = new Date(updatedAtMs).toISOString();
  return value;
}

async function timeoutOf(promise: Promise<unknown>): Promise<BundledBootstrapTimeoutError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(BundledBootstrapTimeoutError);
  return error as BundledBootstrapTimeoutError;
}

test("a serial chain that needs longer than the old flat 360 s finishes while each build moves (hosted shape: 13.2 s a build)", async () => {
  const { clock, options } = fakeClock(13_200);
  let poll = -1;
  const client = {
    async listExtensions() { poll += 1; return []; },
    async extensionControl(_tool: string, { installationId }: { installationId: string }) {
      const index = BUNDLED.findIndex((name) => installationId === bundledInstallationId(name));
      expect(index).toBeGreaterThanOrEqual(0);
      return timed(index < poll ? "verified" : index === poll ? "building" : "queued", index <= poll ? clock.now : 0);
    },
  } as unknown as HarnessClient;
  const result = await waitForBundledBootstrap(client, options);
  expect(clock.now).toBeGreaterThan(360_000);
  expect(result).toMatchObject({
    observer: { policy: BUNDLED_BOOTSTRAP_POLICY, safetyNetMs: bundledBootstrapSafetyNetMs(BUNDLED.length) },
    initialPending: BUNDLED.length,
    terminalOperationStates: { verified: BUNDLED.length },
  });
  requireBundledBootstrapVerified(result, "after a long serial chain");
});

test("no progress ends the wait with an error that names every unverified installation, its state and the stall clock", async () => {
  const { options } = fakeClock();
  const client = {
    async listExtensions() { return []; },
    async extensionControl() { return state("queued", { lease: { fence: 2, until: 60_001 }, events: [{ sequence: 1, state: "building", at: "2026-09-07T00:00:00.000Z" }] }); },
  } as unknown as HarnessClient;
  const timeout = await timeoutOf(waitForBundledBootstrap(client, options));
  // The busy-retry lease holds the wait until 60.001 s; the stall limit runs from there.
  expect(timeout.verdict).toMatchObject({ reason: "stalled", elapsedMs: 181_000, stallClockMs: 120_999, verified: 0, builds: BUNDLED.length });
  expect(timeout.verdict.unverified.map(({ name, state }) => [name, state])).toEqual(BUNDLED.map((name) => [name, "queued"]));
  expect(timeout.message).toStartWith(`Candidate bootstrap did not reach a terminal runner state: no build changed state for 121.0 s (stall limit 120.0 s); 0 of ${BUNDLED.length} verified after 181.0 s`);
  expect(timeout.message).toContain(`${BUNDLED[0]} queued for `);
  expect(timeout.snapshot).toMatchObject({ capturedAt: expect.any(String), initialPending: BUNDLED.length, terminalOperationStates: { queued: BUNDLED.length } });
  expect(timeout.snapshot.terminalOperations[0]?.operations[0]).toMatchObject({ lease: { fence: 2, until: 60_001 }, lastEvent: { state: "building", at: "2026-09-07T00:00:00.000Z" } });
});

test("an R2 observer waits a whole six-minute build lease out, then finishes on two idle polls", async () => {
  const { clock, options } = fakeClock(10_000);
  const client = {
    async listExtensions() { return []; },
    async extensionControl() { return clock.now < 400_000 ? timed("building", 0, { fence: 1, until: 360_000 }) : timed("verified", 400_000); },
  } as unknown as HarnessClient;
  const result = await waitForBundledBootstrap(client, { ...options, requireObservedPending: false });
  expect(result).toMatchObject({ initialPending: BUNDLED.length, terminalOperationStates: { verified: BUNDLED.length } });
  requireBundledBootstrapVerified(result, "after a recovered lease");
  expect(clock.now).toBe(410_000);
});

test("a build left under an expired lease is a stall once the stall limit passes the lease", async () => {
  const { options } = fakeClock(10_000);
  const client = { async listExtensions() { return []; }, async extensionControl() { return timed("building", 0, { fence: 1, until: 360_000 }); } } as unknown as HarnessClient;
  const timeout = await timeoutOf(waitForBundledBootstrap(client, options));
  expect(timeout.verdict).toMatchObject({ reason: "stalled", elapsedMs: 480_000, stallClockMs: 120_000 });
  expect(timeout.verdict.unverified).toHaveLength(BUNDLED.length);
});
