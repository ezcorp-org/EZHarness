import type { ExtensionManifestV4, SandboxProviderDeclaration } from "@ezcorp/extension-contract";

export const sandboxTestDigest = (character: string): string => character.repeat(64);

export function sandboxProviderDeclaration(options: { presetId?: string; helperDigests?: string[] } = {}): SandboxProviderDeclaration {
  return {
    id: "incus",
    profiles: ["linux-exec.v1"],
    presets: [{
      id: options.presetId ?? "nixos-small",
      profile: "linux-exec.v1",
      imageDigest: sandboxTestDigest("1"),
      recipeDigest: sandboxTestDigest("2"),
      helperDigests: options.helperDigests ?? [],
      storage: { workspace: "ephemeral", minimumBytes: 1024 },
      network: { mode: "private", outbound: "restricted" },
      limits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, diskBytes: 2048, timeoutMs: 5000 },
      requirements: { backendApis: ["incus/1.0"], architectures: ["amd64"], storageDrivers: ["zfs"], isolation: ["container"], nestedCompose: false },
      allowedOverrides: {},
    }],
  };
}

export function sandboxExtensionManifest(name = "runtime-sandbox"): ExtensionManifestV4 {
  return {
    schemaVersion: 4,
    name,
    version: "1.0.0",
    description: "fixture",
    author: { name: "Test" },
    permissions: {},
    sandboxProviders: [sandboxProviderDeclaration({ presetId: "small" })],
  };
}
