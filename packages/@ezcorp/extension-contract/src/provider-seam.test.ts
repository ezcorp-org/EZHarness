import { describe, expect, test } from "bun:test";
import type { ExtensionManifestV4, SandboxCompatibilityObservation, SandboxProtocolContribution } from "./types";
import { composeSandboxPreset, linuxSandboxPreset, manifestWithSandboxPresets, sandboxFixtureManifest } from "./sandbox-presets.fixture";
import { CANDIDATE_SANDBOX_QUALIFICATION_CASES, canonicalJson, isSandboxPresetCompatible, resolveSandboxPreset, sandboxProviderMethodSchemas, sha256, validateManifest, validateSandboxProviderContribution, validateSandboxProviderDescription, validateSandboxProviderMethodExchange, validateSandboxProviderMethodValue, type SandboxProtocolOperation } from "./validation";

const configSchema = { type: "object", additionalProperties: false };
const observation: SandboxCompatibilityObservation = {
  backendApi: "incus.v1",
  backendVersion: "6.0.6",
  architecture: "amd64",
  storageDriver: "zfs",
  isolation: "container",
  nestedCompose: true,
};

function contribution(presets = [linuxSandboxPreset()]): SandboxProtocolContribution {
  const provider = manifestWithSandboxPresets(presets).sandboxProviders![0]!;
  return {
    ...provider,
    kind: "sandbox",
    protocolMajor: 1,
    minimumHostContract: { major: 4, minor: 0 },
    configSchema,
    requiredPermissions: ["storage"],
    methodGroups: [{ name: "sandbox.provider.v1", methods: { describe: "sandbox/describe", preflight: "sandbox/preflight" } }],
  };
}

function declaredMethod(operation: SandboxProtocolOperation, name: string) {
  return { name, ...sandboxProviderMethodSchemas(operation) };
}

function contributionManifest(provider = contribution()): ExtensionManifestV4 {
  return {
    ...sandboxFixtureManifest,
    permissions: { storage: true },
    methods: [declaredMethod("describe", "sandbox/describe"), declaredMethod("preflight", "sandbox/preflight")],
    sandboxProviders: [provider],
  };
}

describe("sandbox provider contribution seam", () => {
  test("keeps preset-only declarations valid and requires complete fields at the conformance boundary", () => {
    const legacy = manifestWithSandboxPresets([linuxSandboxPreset()]);
    expect(validateManifest(legacy)).toEqual(legacy);
    expect(() => validateSandboxProviderContribution(legacy.sandboxProviders![0])).toThrow("incomplete");
    expect(validateSandboxProviderContribution(contribution())).toEqual(contribution());
  });

  test("accepts one strict describe/preflight group with canonical method schemas", () => {
    const manifest = contributionManifest();
    expect(validateManifest(manifest)).toEqual(manifest);
    const described = { providerId: "incus", protocolMajor: 1 as const, profiles: ["linux-exec.v1" as const], presetIds: ["default-linux"] };
    expect(validateSandboxProviderMethodExchange("describe", { providerId: "incus" }, described)).toBeTruthy();
    expect(validateSandboxProviderDescription(manifest.sandboxProviders![0], described)).toEqual(described);
    expect(validateSandboxProviderMethodExchange("preflight", {
      providerId: "incus",
      connectionId: "connection-1",
      profile: "linux-exec.v1",
      presetId: "default-linux",
      presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64),
    }, { observation })).toBeTruthy();
  });

  test("matches a multi-profile description as a set against the reviewed contribution", () => {
    const provider = contribution([linuxSandboxPreset(), composeSandboxPreset()]);
    const described = {
      providerId: provider.id,
      protocolMajor: 1,
      profiles: provider.profiles,
      presetIds: provider.presets.map(item => item.id),
    };
    expect(validateSandboxProviderDescription(provider, described)).toEqual(described);
    expect(() => validateSandboxProviderDescription(provider, { ...described, presetIds: ["unreviewed"] })).toThrow("does not match");
  });

  test("rejects partial, unsupported, duplicate, undeclared, exposed, and noncanonical contributions", () => {
    const valid = contribution();
    const exposedProvider = { ...valid, methodGroups: [{ name: "sandbox.provider.v1" as const, methods: { describe: "sandboxDescribe", preflight: "sandbox/preflight" } }] };
    const exposedManifest = contributionManifest(exposedProvider);
    exposedManifest.methods![0] = declaredMethod("describe", "sandboxDescribe");
    exposedManifest.tools = [{ name: "sandboxDescribe", description: "unsafe exposure", inputSchema: configSchema, outputSchema: configSchema }];
    const invalidManifests: ExtensionManifestV4[] = [
      { ...manifestWithSandboxPresets([linuxSandboxPreset()]), sandboxProviders: [{ ...manifestWithSandboxPresets([linuxSandboxPreset()]).sandboxProviders![0]!, kind: "sandbox" }] },
      contributionManifest({ ...valid, protocolMajor: 2 } as unknown as SandboxProtocolContribution),
      contributionManifest({ ...valid, minimumHostContract: { major: 4, minor: 1 } } as unknown as SandboxProtocolContribution),
      contributionManifest({ ...valid, requiredPermissions: ["storage", "storage"] }),
      { ...contributionManifest(valid), permissions: {} },
      contributionManifest({ ...valid, methodGroups: [] }),
      contributionManifest({ ...valid, methodGroups: [{ name: "sandbox.provider.v1", methods: { describe: "sandbox/same", preflight: "sandbox/same" } }] }),
      { ...contributionManifest(valid), methods: [declaredMethod("describe", "sandbox/describe")] },
      exposedManifest,
      { ...contributionManifest(valid), methods: [declaredMethod("describe", "sandbox/describe"), { name: "sandbox/preflight", inputSchema: configSchema, outputSchema: configSchema }] },
      contributionManifest({ ...valid, configSchema: { patternProperties: {} } }),
      contributionManifest({ ...valid, configSchema: { type: "object" } }),
    ];
    for (const manifest of invalidManifests) expect(() => validateManifest(manifest)).toThrow();
  });

  test("keeps provider method values closed and identity-bound", () => {
    expect(() => validateSandboxProviderMethodValue("describe", "input", { providerId: "incus", extra: true })).toThrow();
    expect(() => validateSandboxProviderMethodValue("describe", "result", { providerId: "incus", protocolMajor: 1, profiles: [], presetIds: [] })).toThrow();
    expect(() => validateSandboxProviderMethodExchange("describe", { providerId: "incus" }, { providerId: "other", protocolMajor: 1, profiles: ["linux-exec.v1"], presetIds: ["default-linux"] })).toThrow("changed provider identity");
    expect(() => validateSandboxProviderDescription(contribution(), { providerId: "incus", protocolMajor: 1, profiles: ["linux-exec.v1"], presetIds: ["different"] })).toThrow("does not match");
    expect(() => sandboxProviderMethodSchemas("unsupported" as SandboxProtocolOperation)).toThrow("Unsupported");
  });
});

describe("deterministic sandbox preset resolution", () => {
  test("resolves exact compatible settings and canonical digests without mutating input", async () => {
    const provider = contribution();
    const request = { profile: "linux-exec.v1" as const, presetId: "default-linux", observation, overrides: { cpuMillis: 1_500, memoryBytes: 805_306_368 } };
    const before = structuredClone({ provider, request });
    const first = await resolveSandboxPreset(provider, request);
    const reordered = await resolveSandboxPreset(provider, {
      overrides: { memoryBytes: 805_306_368, cpuMillis: 1_500 },
      observation: { nestedCompose: true, isolation: "container", storageDriver: "zfs", architecture: "amd64", backendVersion: "6.0.6", backendApi: "incus.v1" },
      presetId: "default-linux",
      profile: "linux-exec.v1",
    });
    expect(first).toEqual(reordered);
    expect(first.effectiveSettings.limits).toEqual({ ...linuxSandboxPreset().limits, cpuMillis: 1_500, memoryBytes: 805_306_368 });
    expect(first.effectiveSettingsDigest).toBe(await sha256(canonicalJson(first.effectiveSettings)));
    expect({ provider, request }).toEqual(before);
    expect(Object.hasOwn(first, "cases")).toBe(false);
  });

  test("rejects every unsupported compatibility dimension and Compose capability", async () => {
    const provider = contribution([composeSandboxPreset()]);
    const base = { profile: "persistent-web-compose.v1" as const, presetId: "default-compose", observation };
    const incompatible = [
      { backendApi: "incus.v2" },
      { architecture: "arm64" as const },
      { storageDriver: "dir" },
      { isolation: "virtual-machine" as const },
      { nestedCompose: false },
    ];
    for (const change of incompatible) await expect(resolveSandboxPreset(provider, { ...base, observation: { ...observation, ...change } })).rejects.toThrow("incompatible");
    expect(isSandboxPresetCompatible(composeSandboxPreset(), observation)).toBe(true);
  });

  test("requires an exact preset and never falls back to another profile or ID", async () => {
    const provider = contribution([linuxSandboxPreset(), composeSandboxPreset()]);
    await expect(resolveSandboxPreset(provider, { profile: "linux-exec.v1", presetId: "missing", observation })).rejects.toThrow("do not match");
    await expect(resolveSandboxPreset(provider, { profile: "persistent-web-compose.v1", presetId: "default-linux", observation })).rejects.toThrow("do not match");
  });

  test("rejects unknown, unapproved, fractional, and out-of-bounds overrides", async () => {
    const provider = contribution();
    const base = { profile: "linux-exec.v1" as const, presetId: "default-linux", observation };
    for (const overrides of [{ cpuMillis: 499 }, { cpuMillis: 2_001 }, { cpuMillis: 1_000.5 }, { memoryBytes: 0 }]) await expect(resolveSandboxPreset(provider, { ...base, overrides })).rejects.toThrow("override");
    await expect(resolveSandboxPreset(provider, { ...base, overrides: { unknownLimit: 1 } })).rejects.toThrow();
    const locked = contribution();
    delete locked.presets[0]!.allowedOverrides.cpuMillis;
    await expect(resolveSandboxPreset(locked, { ...base, overrides: { cpuMillis: 1_000 } })).rejects.toThrow("not allowed");
  });

  test("changes the effective digest when meaningful settings or observations change", async () => {
    const provider = contribution();
    const base = { profile: "linux-exec.v1" as const, presetId: "default-linux", observation };
    const original = await resolveSandboxPreset(provider, base);
    const changedLimit = await resolveSandboxPreset(provider, { ...base, overrides: { cpuMillis: 1_500 } });
    const changedBackend = await resolveSandboxPreset(provider, { ...base, observation: { ...observation, backendVersion: "6.0.7" } });
    expect(new Set([original.effectiveSettingsDigest, changedLimit.effectiveSettingsDigest, changedBackend.effectiveSettingsDigest]).size).toBe(3);
    expect(CANDIDATE_SANDBOX_QUALIFICATION_CASES).toEqual(["SP01", "SP02", "SP03", "SP05", "SP07", "SP08"]);
  });
});
