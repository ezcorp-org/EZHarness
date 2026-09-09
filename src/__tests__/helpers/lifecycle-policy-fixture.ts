import type { ReleaseRecord } from "@ezcorp/extension-contract";
import type { LifecyclePolicyLookup } from "../../extensions/extension-lifecycle-service";
import type { InstallationRecord, LifecycleActor } from "../../extensions/v4";

export const actor: LifecycleActor = { principalId: "owner", scope: "global", kind: "agent" };
export const installation: InstallationRecord = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 };
export const release: ReleaseRecord = {
  id: "release", installationId: installation.id, workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "a".repeat(64), artifactDigest: "b".repeat(64), imageDigest: `sha256:${"c".repeat(64)}`, releaseDigest: "d".repeat(64), policyDigest: "e".repeat(64), runnerProfile: "podman", createdAt: new Date(0).toISOString(),
  manifest: { schemaVersion: 4, name: "fixture", version: "1.0.0", author: { name: "Test" }, description: "Test", permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], smokeTest: { tool: "echo", input: { text: "hello" }, expect: { textIncludes: "hello" } } },
  evidence: { protocolVersion: 4, validatorVersion: "test", discoveryDigest: "f".repeat(64), tests: [{ name: "test", passed: true }] },
};

export function lookup(overrides: Partial<LifecyclePolicyLookup> = {}): LifecyclePolicyLookup {
  return {
    async user(id) { return { id, role: id === "admin" ? "admin" : "member", status: "active" }; },
    async installation() { return installation; },
    async projectionById() { return null; },
    async projectionByName() { return null; },
    async projectMember() { return false; },
    ...overrides,
  };
}
