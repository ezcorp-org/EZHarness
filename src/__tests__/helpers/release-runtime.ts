import type { ExtensionManifestV4, InvocationContext, Runner, StartRequest } from "@ezcorp/extension-contract";
import { configureReleaseRuntime, type ActiveExtensionRelease } from "../../extensions/release-process";
import { digestObject } from "../../extensions/v4/blobs";
import { requestedReleaseGrants } from "../../extensions/extension-control";

export function releaseRuntimeFixture(extensionId: string, manifest: ExtensionManifestV4, options: { ownerId?: string; artifactDigest?: string; beforeStart?: (input: StartRequest) => Promise<void>; invoke?: (name: string, input: unknown, context: InvocationContext) => Promise<unknown> } = {}) {
  const releaseId = crypto.randomUUID();
  const calls: StartRequest[] = [];
  const snapshot: ActiveExtensionRelease = {
    installation: { id: extensionId, ownerId: options.ownerId ?? "fixture-owner", scope: "global", activeReleaseId: releaseId, generation: 1, enabled: true, uninstalled: false, status: "active", acknowledgedGeneration: 1, grants: requestedReleaseGrants(manifest) },
    release: { id: releaseId, installationId: extensionId, workspaceId: crypto.randomUUID(), workspaceRevision: 1, sourceDigest: digestObject(manifest), artifactDigest: options.artifactDigest ?? digestObject(manifest), releaseDigest: digestObject(manifest), imageDigest: `sha256:${"a".repeat(64)}`, runnerProfile: "test", policyDigest: "b".repeat(64), manifest, evidence: { protocolVersion: 4, validatorVersion: "test", tests: [{ name: "fixture", passed: true }], discoveryDigest: digestObject(manifest) }, createdAt: new Date().toISOString() },
    limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 30_000 },
  };
  const runner: Runner = {
    async build() { throw new Error("Not a build fixture"); },
    async cancel() {},
    async inspect() { return { id: "fixture", state: "running", diagnostics: [] }; },
    async collectArtifacts() { throw new Error("Not an artifact collection fixture"); },
    async start(input) {
      await options.beforeStart?.(input);
      if (input.artifactDigest !== snapshot.release.artifactDigest) throw new Error("Artifact binding changed");
      calls.push(input);
      return {
        workerId: input.workerId,
        close: async () => {},
        onNotification: () => () => {},
        request: async (method, params) => {
          if (method === "extension/discover") return snapshot.release.manifest;
          if (method !== "extension/invoke" || !options.invoke) throw new Error("Unexpected fixture invocation");
          const invocation = params as { name: string; input: unknown };
          return options.invoke(invocation.name, invocation.input, input.context);
        },
      };
    },
  };
  return { snapshot, calls, runner, configure() { configureReleaseRuntime({ runner: async () => runner, resolve: async (id) => id === extensionId ? snapshot : null }); } };
}
