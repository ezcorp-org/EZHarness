import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { ExtensionProcess } from "../extensions/subprocess";

interface RegistryInternals {
  processes: Map<string, ExtensionProcess>;
  manifests: Map<string, ExtensionManifestV2>;
  installPaths: Map<string, string>;
  grantedPerms: Map<string, ExtensionPermissions>;
  bundledFlags: Map<string, boolean>;
}

const manifest = (version: string, checksum: string): ExtensionManifestV2 => ({
  schemaVersion: 2,
  name: "reload-test",
  version,
  description: "reload test",
  author: { name: "test" },
  entrypoint: "./index.ts",
  tools: [{ name: "run", description: "run", inputSchema: { type: "object" } }],
  permissions: {},
  checksum,
});

describe("ExtensionRegistry.reload process invalidation", () => {
  afterEach(() => ExtensionRegistry.resetInstance());

  test("kills only subprocesses whose runtime inputs changed", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    const killed: string[] = [];
    const fakeProcess = (id: string) => ({
      isRunning: true,
      kill: () => killed.push(id),
    }) as unknown as ExtensionProcess;
    const grants = { grantedAt: {} } as ExtensionPermissions;

    state.processes.set("changed", fakeProcess("changed"));
    state.processes.set("unchanged", fakeProcess("unchanged"));
    state.manifests.set("changed", manifest("1.0.0", "old"));
    state.manifests.set("unchanged", manifest("1.0.0", "same"));
    state.installPaths.set("changed", "/tmp/changed");
    state.installPaths.set("unchanged", "/tmp/unchanged");
    state.grantedPerms.set("changed", grants);
    state.grantedPerms.set("unchanged", grants);
    state.bundledFlags.set("changed", false);
    state.bundledFlags.set("unchanged", false);

    registry.loadFromDb = async () => {
      state.manifests.clear();
      state.installPaths.clear();
      state.grantedPerms.clear();
      state.bundledFlags.clear();
      state.manifests.set("changed", manifest("1.1.0", "new"));
      state.manifests.set("unchanged", manifest("1.0.0", "same"));
      state.installPaths.set("changed", "/tmp/changed");
      state.installPaths.set("unchanged", "/tmp/unchanged");
      state.grantedPerms.set("changed", grants);
      state.grantedPerms.set("unchanged", grants);
      state.bundledFlags.set("changed", false);
      state.bundledFlags.set("unchanged", false);
    };

    await registry.reload();

    expect(killed).toEqual(["changed"]);
    expect(state.processes.has("changed")).toBe(false);
    expect(state.processes.has("unchanged")).toBe(true);
  });
});
