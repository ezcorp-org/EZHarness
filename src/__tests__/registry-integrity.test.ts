import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionRegistry } from "../extensions/registry";
import { configureReleaseRuntime, getReleaseRuntime, ReleaseProcess } from "../extensions/release-process";
import type { ExtensionManifestV2 } from "../extensions/types";

afterEach(() => ExtensionRegistry.resetInstance());

function manifest(schemaVersion: number): ExtensionManifestV2 {
  return { schemaVersion, name: "test-ext", version: "1.0.0", description: "Test", author: { name: "Test" }, entrypoint: "extension.ts", tools: [], permissions: {} } as ExtensionManifestV2;
}

function prepare() {
  configureReleaseRuntime({ runner: async () => { throw new Error("No worker should start during registration"); }, resolve: async () => null });
  expect(getReleaseRuntime()).toBeDefined();
  return ExtensionRegistry.getInstance();
}

describe("registry immutable release boundary", () => {
  test("legacy code cannot run even with a matching checksum", async () => {
    const registry = prepare();
    registry.setManifestForTest("old", { ...manifest(2), packageChecksums: { "extension.ts": "checksum" } });
    registry.setInstallPathForTest("old", "/tmp/untrusted");
    await expect(registry.getProcess("old")).rejects.toThrow("approved v4 release");
  });

  test("legacy code cannot run without a checksum", async () => {
    const registry = prepare();
    registry.setManifestForTest("old", manifest(3));
    registry.setInstallPathForTest("old", "/tmp/untrusted");
    await expect(registry.getProcess("old")).rejects.toThrow("approved v4 release");
  });

  test("unregistered extensions cannot run", async () => {
    await expect(prepare().getProcess("missing")).rejects.toThrow("approved v4 release");
  });

  test("v4 creates a runner adapter without a host path and reuses its dispatcher", async () => {
    const registry = prepare();
    registry.setManifestForTest("release", manifest(4));
    const process = await registry.getProcess("release");
    expect(process).toBeInstanceOf(ReleaseProcess);
    expect(process.getSpawnCwd()).toBeUndefined();
    expect(() => process.getSpawnArgs()).toThrow("release runner");
    expect(await registry.getProcess("release")).toBe(process);
  });

  test("retired adapters are replaced but never regain a host execution fallback", async () => {
    const registry = prepare();
    registry.setManifestForTest("release", manifest(4));
    const previous = await registry.getProcess("release");
    previous.kill();
    const next = await registry.getProcess("release", { shellAllowed: true, networkAllowed: true });
    expect(next).not.toBe(previous);
    expect(next).toBeInstanceOf(ReleaseProcess);
    await expect(next.call("tools/call", { name: "read", arguments: {} })).rejects.toThrow("active acknowledged release");
  });
});
