import { expect, spyOn, test } from "bun:test";
import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { bundledInstallationId } from "../../src/extensions/bundled-bootstrap";
import { BUNDLED_BOOTSTRAP_POLICY, bundledBootstrapSafetyNetMs } from "./bundled-bootstrap-progress";
import { BuildWaitTimeoutError, BundledBootstrapTimeoutError, requireBundledBootstrapVerified, waitForBuildVerified, waitForBundledBootstrap } from "./shipping-bootstrap-state";

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
      // A build changes state twice: it starts at poll `index` and verifies at poll `index + 1`; its timestamp stays put after that.
      return index < poll ? timed("verified", (index + 1) * 13_200) : index === poll ? timed("building", index * 13_200) : timed("queued", 0);
    },
  } as unknown as HarnessClient;
  const result = await waitForBundledBootstrap(client, options);
  expect(clock.now).toBeGreaterThan(360_000);
  // The receipt names the total (past the old flat 360 s) and the stall clock's maximum (one build step, far under the limit).
  expect(result.progress).toEqual({ elapsedMs: clock.now, maxStallClockMs: 13_200, stallMs: 120_000, safetyNetMs: bundledBootstrapSafetyNetMs(BUNDLED.length), lastProgressAt: new Date(BUNDLED.length * 13_200).toISOString() });
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
  // Silence under the live lease does not count; the clock runs only from the lease's end (360 s) to the change seen at 400 s.
  expect(result.progress).toMatchObject({ elapsedMs: 410_000, maxStallClockMs: 30_000 });
});

test("a build left under an expired lease is a stall once the stall limit passes the lease", async () => {
  const { options } = fakeClock(10_000);
  const client = { async listExtensions() { return []; }, async extensionControl() { return timed("building", 0, { fence: 1, until: 360_000 }); } } as unknown as HarnessClient;
  const timeout = await timeoutOf(waitForBundledBootstrap(client, options));
  expect(timeout.verdict).toMatchObject({ reason: "stalled", elapsedMs: 480_000, stallClockMs: 120_000 });
  expect(timeout.verdict.unverified).toHaveLength(BUNDLED.length);
});

// waitForBuildVerified: one build that shares the runner with the bundled bootstrap (the historical upgrade's red, R5 2026-10-07).
function awaited(status: "queued" | "building" | "verified" | "failed", updatedAtMs: number, releaseId: string | null = "release") {
  return {
    operations: { user: { id: "user", kind: "build", state: status, diagnostics: status === "failed" ? [{ code: "test_failed" }] : [], events: [], updatedAt: new Date(updatedAtMs).toISOString(), ...(releaseId ? { releaseId } : {}) } },
    releases: releaseId ? { [releaseId]: { id: releaseId } } : {},
  };
}

test("a build queued behind the whole bundled chain waits it out past the old flat 360 s and returns the verified state", async () => {
  const { clock, options } = fakeClock(13_200);
  let poll = -1;
  const client = {
    async listExtensions() { return []; },
    async extensionControl(_tool: string, input: { installationId: string; operationId?: string; waitMs?: number }) {
      if (input.installationId === "user-installation") {
        // The awaited build long-polls on its own operation and starts only after every bundled build verified.
        expect(input).toEqual({ installationId: "user-installation", operationId: "user", waitMs: 30_000 });
        poll += 1;
        return poll <= BUNDLED.length ? awaited("queued", 0) : awaited("verified", poll * 13_200);
      }
      const index = BUNDLED.findIndex((name) => input.installationId === bundledInstallationId(name));
      expect(index).toBeGreaterThanOrEqual(0);
      return index < poll ? timed("verified", (index + 1) * 13_200) : index === poll ? timed("building", index * 13_200) : timed("queued", 0);
    },
  } as unknown as HarnessClient;
  const result = await waitForBuildVerified(client, "user-installation", "user", options);
  expect(clock.now).toBeGreaterThan(360_000);
  expect(result.operations.user).toMatchObject({ state: "verified", releaseId: "release" });
});

test("no progress in the shared queue ends the wait with an error that names the awaited build, its state and the stall clock", async () => {
  const { clock, options } = fakeClock();
  const client = {
    async listExtensions() { return []; },
    async extensionControl(_tool: string, { installationId }: { installationId: string }) {
      return installationId === "user-installation" ? awaited("queued", 0) : timed("verified", 0);
    },
  } as unknown as HarnessClient;
  const error = await waitForBuildVerified(client, "user-installation", "user", options).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(BuildWaitTimeoutError);
  const timeout = error as BuildWaitTimeoutError;
  expect(timeout.operationId).toBe("user");
  expect(timeout.verdict).toMatchObject({ reason: "stalled", stallClockMs: 120_000, verified: BUNDLED.length, builds: BUNDLED.length + 1, unverified: [{ name: "build user", state: "queued", sinceTransitionMs: clock.now }] });
  expect(timeout.message).toStartWith(`Build user did not finish: no build changed state for 120.0 s (stall limit 120.0 s); ${BUNDLED.length} of ${BUNDLED.length + 1} verified`);
  expect(timeout.message).toContain("not verified: build user queued for 120.0 s");
});

test("a live lease on the awaited build holds the stall clock until it expires", async () => {
  const { clock, options } = fakeClock(10_000);
  const client = {
    async listExtensions() { return []; },
    async extensionControl(_tool: string, { installationId }: { installationId: string }) {
      if (installationId !== "user-installation") return timed("verified", 0);
      const value = awaited("building", 0);
      return { ...value, operations: { user: { ...value.operations.user, lease: { fence: 1, until: 300_000 } } } };
    },
  } as unknown as HarnessClient;
  const timeout = await waitForBuildVerified(client, "user-installation", "user", options).then(() => undefined, (caught: unknown) => caught as BuildWaitTimeoutError);
  expect(timeout?.verdict.reason).toBe("stalled");
  expect(clock.now).toBe(420_000);
});

test("a build that is already terminal returns without reading the bundled queue", async () => {
  let listed = 0;
  const client = {
    async listExtensions() { listed += 1; return []; },
    async extensionControl() { return awaited("verified", 0); },
  } as unknown as HarnessClient;
  const result = await waitForBuildVerified(client, "user-installation", "user", { now: () => 0, sleep: async () => { throw new Error("no sleep"); } });
  expect(result.operations.user.state).toBe("verified");
  expect(listed).toBe(0);
});

test("a failed build, a verified build without its release and a vanished operation are named errors", async () => {
  const once = (value: unknown) => ({ async listExtensions() { return []; }, async extensionControl() { return value; } }) as unknown as HarnessClient;
  const options = { now: () => 0, sleep: async () => undefined };
  await expect(waitForBuildVerified(once(awaited("failed", 0)), "user-installation", "user", options)).rejects.toThrow('Build user ended failed: [{"code":"test_failed"}]');
  await expect(waitForBuildVerified(once(awaited("verified", 0, null)), "user-installation", "user", options)).rejects.toThrow("Build user verified without a release");
  await expect(waitForBuildVerified(once({ operations: {}, releases: {} }), "user-installation", "user", options)).rejects.toThrow("Build user disappeared from installation user-installation");
});
