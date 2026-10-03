import type { ExtensionManifestV4, SandboxPreset } from "./types";

export const SANDBOX_FIXTURE_NOW = Date.parse("2026-09-21T12:00:00.000Z");
export const SANDBOX_FIXTURE_RELEASE_DIGEST = "a".repeat(64);
export const SANDBOX_FIXTURE_SETTINGS_DIGEST = "f".repeat(64);

export const sandboxFixtureManifest = {
  schemaVersion: 4,
  name: "sandbox-provider",
  version: "1.0.0",
  description: "Sandbox provider",
  author: { name: "Test" },
  permissions: {},
} satisfies ExtensionManifestV4;

export function linuxSandboxPreset(id = "default-linux"): SandboxPreset {
  return {
    id,
    profile: "linux-exec.v1",
    imageDigest: "b".repeat(64),
    recipeDigest: "c".repeat(64),
    helperDigests: ["d".repeat(64)],
    storage: { workspace: "ephemeral", minimumBytes: 1_073_741_824 },
    network: { mode: "private", outbound: "restricted" },
    limits: { memoryBytes: 1_073_741_824, cpuMillis: 1_000, pids: 256, diskBytes: 2_147_483_648, timeoutMs: 600_000 },
    requirements: { backendApis: ["incus.v1"], architectures: ["amd64"], storageDrivers: ["zfs"], isolation: ["container"], nestedCompose: false },
    allowedOverrides: {
      memoryBytes: { minimum: 536_870_912, maximum: 2_147_483_648 },
      cpuMillis: { minimum: 500, maximum: 2_000 },
      pids: { minimum: 128, maximum: 512 },
      diskBytes: { minimum: 1_073_741_824, maximum: 4_294_967_296 },
      timeoutMs: { minimum: 60_000, maximum: 1_200_000 },
    },
  };
}

export function composeSandboxPreset(id = "default-compose"): SandboxPreset {
  const preset = linuxSandboxPreset(id);
  return {
    ...preset,
    profile: "persistent-web-compose.v1",
    imageDigest: "e".repeat(64),
    storage: { ...preset.storage, workspace: "persistent" },
    requirements: { ...preset.requirements, nestedCompose: true },
  };
}

export function manifestWithSandboxPresets(presets: SandboxPreset[], profiles = [...new Set(presets.map(preset => preset.profile))]): ExtensionManifestV4 {
  return { ...sandboxFixtureManifest, sandboxProviders: [{ id: "incus", profiles, presets }] };
}
