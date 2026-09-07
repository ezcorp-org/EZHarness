import { expect, spyOn, test } from "bun:test";
import type { HarnessClient } from "@ezcorp/harness-client";
import { resolveBundledExtensions } from "../../src/extensions/bundled";
import { BundledBootstrapTimeoutError, requireBundledBootstrapVerified, waitForBundledBootstrap } from "./shipping-bootstrap-state";

function state(status: "queued" | "verified" | "failed") {
  return { operations: { build: { id: "build", kind: "build", state: status, diagnostics: [] } } };
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

test("reports the final pending operations in a bounded bootstrap timeout", async () => {
  let now = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { now += 1; });
  const client = { async listExtensions() { return []; }, async extensionControl() { return state("queued"); } } as unknown as HarnessClient;
  try {
    await expect(waitForBundledBootstrap(client, { deadlineMs: 1 })).rejects.toMatchObject({
      name: "BundledBootstrapTimeoutError",
      snapshot: {
        bootstrapInstallations: resolveBundledExtensions().length,
        initialPending: resolveBundledExtensions().length,
        maximumPending: resolveBundledExtensions().length,
        terminalOperationStates: { queued: resolveBundledExtensions().length },
      },
    } satisfies Partial<BundledBootstrapTimeoutError>);
  } finally {
    sleep.mockRestore();
    clock.mockRestore();
  }
});
