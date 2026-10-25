import { describe, expect, test } from "bun:test";
import {
  sandboxProviderMethodSchemas,
  validateSandboxProviderContribution,
  type ExtensionManifestV4,
  type ReleaseRecord,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
  type SandboxProtocolContribution,
} from "@ezcorp/extension-contract";
import { digestObject } from "./blobs";
import { runSandboxCandidateConformance, type SandboxConformanceDependencies, type SandboxWorkspaceIdentity } from "./sandbox-conformance";
import { describeIncusProvider } from "../../../extensions/incus-sandbox/adapter";
import { incusManifest } from "../../../extensions/incus-sandbox/manifest";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const digest = (character: string) => character.repeat(64);
const realIncusProvider = validateSandboxProviderContribution(incusManifest.sandboxProviders![0]!);

function preset(id: string, compose = false): SandboxPreset {
  return {
    id,
    profile: compose ? "persistent-web-compose.v1" : "linux-exec.v1",
    imageDigest: digest(compose ? "4" : "1"),
    recipeDigest: digest("2"),
    helperDigests: [digest("3")],
    storage: { workspace: compose ? "persistent" : "ephemeral", minimumBytes: 1024 },
    network: { mode: "private", outbound: "restricted" },
    limits: { memoryBytes: 2048, cpuMillis: 1000, pids: 16, diskBytes: 4096, timeoutMs: 5000 },
    requirements: { backendApis: ["incus.v1"], architectures: ["amd64"], storageDrivers: ["zfs"], isolation: ["container"], nestedCompose: compose },
    allowedOverrides: { memoryBytes: { minimum: 1024, maximum: 4096 } },
  };
}

function contribution(presets = [preset("small"), preset("compose", true)]): SandboxProtocolContribution {
  const profiles = [...new Set(presets.map(item => item.profile))];
  return {
    id: "incus",
    profiles,
    presets,
    kind: "sandbox",
    protocolMajor: 1,
    minimumHostContract: { major: 4, minor: 0 },
    configSchema: { type: "object", additionalProperties: false },
    requiredPermissions: [],
    methodGroups: [{ name: "sandbox.provider.v1", methods: { describe: "sandbox/describe", preflight: "sandbox/preflight" } }],
  };
}

function manifest(provider?: SandboxProtocolContribution): ExtensionManifestV4 {
  const describe = sandboxProviderMethodSchemas("describe");
  const preflight = sandboxProviderMethodSchemas("preflight");
  return {
    schemaVersion: 4,
    name: "sandbox-conformance-fixture",
    version: "1.0.0",
    description: "Fixture",
    author: { name: "Test" },
    permissions: {},
    ...(provider ? {
      sandboxProviders: [provider],
      methods: [
        { name: "sandbox/describe", inputSchema: describe.inputSchema, outputSchema: describe.outputSchema },
        { name: "sandbox/preflight", inputSchema: preflight.inputSchema, outputSchema: preflight.outputSchema },
      ],
    } : {}),
  };
}

function release(provider?: SandboxProtocolContribution, suppliedManifest?: ExtensionManifestV4): ReleaseRecord {
  const releaseInput = {
    installationId: "installation-1",
    workspaceId: "workspace-1",
    workspaceRevision: 7,
    sourceDigest: digest("a"),
    artifactDigest: digest("b"),
    imageDigest: digest("c"),
    manifest: suppliedManifest ?? manifest(provider),
    evidence: { protocolVersion: 4 as const, validatorVersion: "4.0.0", tests: [{ name: "build", passed: true }], discoveryDigest: digest("d") },
    runnerProfile: "isolated",
    policyDigest: digest("e"),
  };
  return { id: "release-1", createdAt: "2026-09-22T11:00:00.000Z", ...releaseInput, releaseDigest: digestObject(releaseInput) };
}

function observationFor(item: SandboxPreset): SandboxCompatibilityObservation {
  return {
    backendApi: item.requirements.backendApis[0]!,
    backendVersion: "host-conformance-v1",
    architecture: item.requirements.architectures[0]!,
    storageDriver: item.requirements.storageDrivers[0]!,
    isolation: item.requirements.isolation[0]!,
    nestedCompose: item.requirements.nestedCompose,
  };
}

function dependencies(provider: SandboxProtocolContribution, overrides: Partial<SandboxConformanceDependencies> = {}): SandboxConformanceDependencies & { calls: string[]; proofs: SandboxWorkspaceIdentity[] } {
  const calls: string[] = [];
  const proofs: SandboxWorkspaceIdentity[] = [];
  return {
    calls,
    proofs,
    now: () => NOW,
    async invoke(method, input) {
      calls.push(method);
      if (method === "sandbox/describe") return { providerId: provider.id, protocolMajor: 1, profiles: provider.profiles, presetIds: provider.presets.map(item => item.id) };
      const presetId = (input as { presetId: string }).presetId;
      return { observation: observationFor(provider.presets.find(item => item.id === presetId)!) };
    },
    async proveWorkspaceRouting(identity) {
      proofs.push(identity);
      return {
        binding: identity,
        cases: [
          { toolName: "readFile", localFallbackDenied: true },
          { toolName: "editFile", localFallbackDenied: true },
          { toolName: "shell", localFallbackDenied: true },
        ],
        hostCanaryUnchanged: true,
      };
    },
    ...overrides,
  };
}

function realIncusHost(describeResult: unknown = describeIncusProvider()) {
  return dependencies(realIncusProvider, {
    invoke: async (method, input) => method === "incus/describe"
      ? describeResult
      : { observation: observationFor(realIncusProvider.presets.find(item => item.id === (input as { presetId: string }).presetId)!) },
  });
}

describe("host sandbox conformance", () => {
  test("accepts the real Incus description against its signed manifest", async () => {
    const host = realIncusHost();
    const result = await runSandboxCandidateConformance(release(realIncusProvider, incusManifest), host);
    expect(result.map(item => item.presetId)).toEqual(realIncusProvider.presets.map(item => item.id));
    expect(result.every(item => item.cases.every(entry => entry.status === "passed"))).toBe(true);
  });

  test("rejects a real Incus description that omits signed capabilities", async () => {
    const { capabilities: _capabilities, ...withoutCapabilities } = describeIncusProvider() as { capabilities: unknown };
    const host = realIncusHost(withoutCapabilities);
    await expect(runSandboxCandidateConformance(release(realIncusProvider, incusManifest), host)).rejects.toMatchObject({
      code: "sandbox_conformance_failed",
    });
    expect(host.proofs).toEqual([]);
  });

  test("does nothing for an ordinary extension", async () => {
    const result = await runSandboxCandidateConformance(release(), {
      invoke: async () => { throw new Error("must not run"); },
      now: () => NOW,
    });
    expect(result).toEqual([]);
  });

  test("executes every static case before emitting exact current evidence", async () => {
    const provider = contribution();
    const host = dependencies(provider);
    const result = await runSandboxCandidateConformance(release(provider), host);
    expect(result).toHaveLength(2);
    expect(result.map(item => `${item.providerId}/${item.presetId}`)).toEqual(["incus/small", "incus/compose"]);
    expect(result.every(item => item.cases.map(entry => entry.caseId).join(",") === "SP01,SP02,SP03,SP05,SP07,SP08")).toBe(true);
    expect(result.every(item => item.cases.every(entry => entry.status === "passed"))).toBe(true);
    expect(result.every(item => item.verifiedAt === "2026-09-22T12:00:00.000Z" && item.validUntil === "2026-09-22T13:00:00.000Z")).toBe(true);
    expect(host.calls).toEqual(["sandbox/describe", "sandbox/preflight", "sandbox/preflight", "sandbox/preflight", "sandbox/preflight"]);
    expect(host.proofs).toHaveLength(2);
    expect(host.proofs[0]).toMatchObject({ providerId: "incus", presetId: "small", workspaceId: "workspace-1" });
  });

  test("fails closed without an executed SP05 routing proof", async () => {
    const provider = contribution([preset("small")]);
    const host = dependencies(provider);
    delete host.proveWorkspaceRouting;
    await expect(runSandboxCandidateConformance(release(provider), host)).rejects.toMatchObject({ code: "sandbox_workspace_proof_required" });
    expect(host.calls).toEqual([]);
  });

  test("rejects provider catalog drift, preflight drift, nondeterminism, and provider faults", async () => {
    const provider = contribution([preset("small")]);
    const cases: SandboxConformanceDependencies[] = [
      dependencies(provider, { invoke: async method => method === "sandbox/describe" ? { providerId: "other", protocolMajor: 1, profiles: provider.profiles, presetIds: ["small"] } : { observation: observationFor(provider.presets[0]!) } }),
      dependencies(provider, { invoke: async method => method === "sandbox/describe" ? { providerId: provider.id, protocolMajor: 1, profiles: provider.profiles, presetIds: ["small"] } : { observation: { ...observationFor(provider.presets[0]!), backendVersion: "unexpected" } } }),
      (() => {
        let preflights = 0;
        return dependencies(provider, { invoke: async method => method === "sandbox/describe" ? { providerId: provider.id, protocolMajor: 1, profiles: provider.profiles, presetIds: ["small"] } : { observation: { ...observationFor(provider.presets[0]!), backendVersion: ++preflights === 1 ? "host-conformance-v1" : "changed" } } });
      })(),
      dependencies(provider, { invoke: async () => { throw new Error("provider stopped"); } }),
    ];
    for (const host of cases) await expect(runSandboxCandidateConformance(release(provider), host)).rejects.toMatchObject({ code: "sandbox_conformance_failed" });
  });

  test("rejects absent contribution fields, invalid time, corrupt releases, and mismatched SP05 identities", async () => {
    const provider = contribution([preset("small")]);
    const incomplete = structuredClone(provider) as SandboxProtocolContribution;
    delete (incomplete as Partial<SandboxProtocolContribution>).kind;
    const corrupt = release(provider);
    corrupt.artifactDigest = digest("f");
    const invalid: Array<[ReleaseRecord, SandboxConformanceDependencies]> = [
      [release(incomplete), dependencies(incomplete)],
      [release(provider), dependencies(provider, { now: () => Number.NaN })],
      [corrupt, dependencies(provider)],
      [release(provider), dependencies(provider, { proveWorkspaceRouting: async identity => ({
        binding: { ...identity, workspaceId: "wrong" },
        cases: [
          { toolName: "readFile", localFallbackDenied: true },
          { toolName: "editFile", localFallbackDenied: true },
          { toolName: "shell", localFallbackDenied: true },
        ],
        hostCanaryUnchanged: true,
      }) })],
    ];
    for (const [candidate, host] of invalid) await expect(runSandboxCandidateConformance(candidate, host)).rejects.toMatchObject({ code: "sandbox_conformance_failed" });
  });

  test("chooses unsupported probes outside broad declared compatibility lists", async () => {
    const broad = preset("broad");
    broad.requirements.backendApis.push("unsupported.backend.v1");
    broad.requirements.storageDrivers.push("unsupported-storage");
    broad.requirements.architectures.push("arm64");
    broad.requirements.isolation.push("virtual-machine");
    const provider = contribution([broad]);
    await expect(runSandboxCandidateConformance(release(provider), dependencies(provider))).resolves.toHaveLength(1);
  });
});
