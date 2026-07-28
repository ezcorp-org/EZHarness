/**
 * H1.3 — a registry reload must not kill a subprocess mid-call.
 *
 * `installAuthoredDraft` calls `registry.reload()` from INSIDE the
 * `ezcorp/drafts.install` reverse-RPC handler — i.e. while the host is
 * still awaiting the `install_draft` tool call that triggered it — and
 * `installFromLocal` self-reloads too, so this fires twice per install.
 * Because that install also moves `extension-author`'s own runtime
 * signature (the bundled grant self-heal rewrites `grantedPermissions`),
 * reload's invalidation used to `proc.kill()` the caller out from under
 * itself: the tool call never returned and the chat wedged. That is the
 * symptom `web/e2e/extension-author-stuck-chat.spec.ts` guards.
 *
 * This drives a REAL subprocess (fixture parks the `tools/call` response
 * until released) and asserts BOTH halves of the fix: the in-flight call
 * completes, AND the stale process is still invalidated afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { ExtensionProcess } from "../extensions/subprocess";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures/blocking-tool-extension");
const EXT_ID = "ext-blocking-tool";

const manifest = (checksum: string): ExtensionManifestV2 => ({
  schemaVersion: 2,
  name: "blocking-tool",
  version: "1.0.0",
  description: "parks a tool call until released",
  author: { name: "test" },
  entrypoint: "./entrypoint.ts",
  persistent: true,
  tools: [{ name: "block", description: "block", inputSchema: { type: "object" } }],
  permissions: {},
  checksum,
});

interface RegistryInternals {
  processes: Map<string, ExtensionProcess>;
  manifests: Map<string, ExtensionManifestV2>;
  installPaths: Map<string, string>;
  grantedPerms: Map<string, ExtensionPermissions>;
  bundledFlags: Map<string, boolean>;
}

/** Poll until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

describe("reload with a real in-flight subprocess call", () => {
  afterEach(() => ExtensionRegistry.resetInstance());

  test("the parked call completes and the stale process is reaped after it", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;

    registry.setManifestForTest(EXT_ID, manifest("hash-before-upgrade"));
    registry.setInstallPathForTest(EXT_ID, FIXTURE_DIR);
    registry.setGrantedPermsForTest(EXT_ID, { grantedAt: {} } as ExtensionPermissions);

    const proc = await registry.getProcess(EXT_ID);
    let parked = false;
    proc.setNotificationHandler((n) => {
      if (n.method === "test/parked") parked = true;
    });

    // Fire the tool call and hold it open. `callTool` resolves only once
    // the fixture is released.
    const callPromise = proc.callTool("block", {});
    await waitFor(() => parked, "the subprocess to park the call");
    expect(proc.inFlightCallCount).toBe(1);

    // The upgrade: same extension, new code hash. Mirrors what the
    // install path's self-reload does to extension-author.
    registry.loadFromDb = async () => {
      state.manifests.set(EXT_ID, manifest("hash-after-upgrade"));
    };
    await registry.reload();

    // Detached, so the next getProcess() spawns the new code…
    expect(state.processes.has(EXT_ID)).toBe(false);
    // …but the blocked caller is still alive and still owns the call.
    expect(proc.isRunning).toBe(true);
    expect(proc.inFlightCallCount).toBe(1);

    // Release: the in-flight call must return a real result, not a
    // "Transport closed" from a kill that landed underneath it.
    proc.sendNotification("test/release");
    const result = await callPromise;
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]).toEqual({ type: "text", text: "released" });

    // …and the deferred invalidation still lands.
    await waitFor(() => !proc.isRunning, "the stale process to be reaped");
    expect(proc.isRunning).toBe(false);

    // An idle process settles immediately — nothing left to wait on.
    await proc.whenCallsSettled();
    expect(proc.inFlightCallCount).toBe(0);
  }, 60_000);
});
