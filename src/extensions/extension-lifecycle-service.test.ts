import { describe, expect, test } from "bun:test";
import type { ReleaseRecord, Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { createLifecycleAuthorization, runStorageMigration, verifyExtensionCandidate, type LifecyclePolicyLookup } from "./extension-lifecycle-service";
import { requestedReleaseGrants } from "./extension-control";
import type { InstallationRecord, LifecycleActor } from "./v4";

const actor: LifecycleActor = { principalId: "owner", scope: "global", kind: "agent" };
const installation: InstallationRecord = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 };
const release: ReleaseRecord = {
  id: "release", installationId: installation.id, workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "a".repeat(64), artifactDigest: "b".repeat(64), imageDigest: `sha256:${"c".repeat(64)}`, releaseDigest: "d".repeat(64), policyDigest: "e".repeat(64), runnerProfile: "podman", createdAt: new Date(0).toISOString(),
  manifest: { schemaVersion: 4, name: "fixture", version: "1.0.0", author: { name: "Test" }, description: "Test", permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], smokeTest: { tool: "echo", input: { text: "hello" }, expect: { textIncludes: "hello" } } },
  evidence: { protocolVersion: 4, validatorVersion: "test", discoveryDigest: "f".repeat(64), tests: [{ name: "test", passed: true }] },
};

function lookup(overrides: Partial<LifecyclePolicyLookup> = {}): LifecyclePolicyLookup {
  return {
    async user(id) { return { id, role: id === "admin" ? "admin" : "member", status: "active" }; },
    async installation() { return installation; },
    async projectionById() { return null; },
    async projectionByName() { return null; },
    async projectMember() { return false; },
    ...overrides,
  };
}

describe("production lifecycle authorization", () => {
  test("only active human administrators approve", async () => {
    const policy = createLifecycleAuthorization(lookup());
    await expect(policy.authorize(actor, "approve", release, [])).rejects.toMatchObject({ code: "human_admin_required" });
    await expect(policy.authorize({ ...actor, principalId: "admin" }, "approve", release, [])).rejects.toMatchObject({ code: "human_admin_required" });
    await policy.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, []);
    const inactive = createLifecycleAuthorization(lookup({ async user(id) { return { id, role: "admin", status: "inactive" }; } }));
    await expect(inactive.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, [])).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("admin approval cannot reactivate a deleted or inactive owner", async () => {
    const policy = createLifecycleAuthorization(lookup({ async user(id) { return id === "admin" ? { id, role: "admin", status: "active" } : undefined; } }));
    await expect(policy.authorize({ ...actor, principalId: "admin", kind: "human" }, "approve", release, [])).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("exact grants cannot omit or add a permission", async () => {
    const policy = createLifecycleAuthorization(lookup());
    const granted = { ...release, manifest: { ...release.manifest, permissions: { network: ["https://example.com"] } } };
    await expect(policy.authorize(actor, "activate", granted, [])).rejects.toMatchObject({ code: "grant_mismatch" });
    await policy.authorize(actor, "activate", granted, requestedReleaseGrants(granted.manifest));
    await expect(policy.authorize(actor, "activate", granted, [...requestedReleaseGrants(granted.manifest), "shell"])).rejects.toMatchObject({ code: "grant_mismatch" });
  });

  test("another owner cannot read state or activate by a known ID", async () => {
    const policy = createLifecycleAuthorization(lookup());
    await expect(policy.authorizeAccess!({ ...actor, principalId: "other" }, installation)).rejects.toMatchObject({ code: "not_found" });
    await expect(policy.authorize({ ...actor, principalId: "other" }, "activate", release, [])).rejects.toMatchObject({ code: "not_found" });
    await policy.authorizeAccess!({ ...actor, principalId: "admin", kind: "human" }, installation);
  });

  test("name takeover and namespace rename fail before activation", async () => {
    const collision = createLifecycleAuthorization(lookup({ async projectionByName() { return { id: "other", name: "fixture", creatorUserId: "other", modifiable: false }; } }));
    await expect(collision.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "extension_name_in_use" });
    const rename = createLifecycleAuthorization(lookup({ async projectionById() { return { id: installation.id, name: "original", creatorUserId: "owner", modifiable: true }; } }));
    await expect(rename.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "extension_name_changed" });
  });

  test("owner modification and project membership must remain authorized", async () => {
    const fixed = createLifecycleAuthorization(lookup({ async projectionById() { return { id: installation.id, name: "fixture", creatorUserId: "owner", modifiable: false }; } }));
    await expect(fixed.authorize(actor, "activate", release, [])).rejects.toMatchObject({ code: "modification_denied" });
    const scoped = createLifecycleAuthorization(lookup());
    await expect(scoped.authorize({ ...actor, scope: "project:private" }, "workspace")).rejects.toMatchObject({ code: "forbidden" });
    await expect(scoped.authorize({ ...actor, scope: "caller-forged-scope" }, "workspace")).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

function candidateRunner(request: RunnerExecution["request"]): { runner: Runner; closed: () => boolean; contexts: unknown[] } {
  let closed = false;
  const contexts: unknown[] = [];
  const runner: Runner = {
    async build() { throw new Error("not used"); }, async cancel() {}, async inspect() { return { id: "worker", state: "running", diagnostics: [] }; }, async collectArtifacts() { return {}; },
    async start(input) {
      contexts.push(input.context);
      return { workerId: input.workerId, request, async close() { closed = true; }, onNotification() { return () => {}; } };
    },
  };
  return { runner, closed: () => closed, contexts };
}

describe("candidate verification", () => {
  test("storage migration binds identity, denies effects, validates output and closes its worker", async () => {
    const candidate = structuredClone(release);
    candidate.manifest.methods = [{ name: "migrate", description: "Migrate", inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["values"] } }];
    const input = { release: candidate, method: "migrate", principalId: "owner", scope: "private", fromVersion: "1", toVersion: "2", values: { note: "retained" } };
    const calls: unknown[] = [];
    const fixture = candidateRunner(async (method, payload) => { calls.push({ method, payload }); return { values: input.values }; });
    const originalStart = fixture.runner.start;
    fixture.runner.start = async (request, reverse) => {
      await expect(reverse("ezcorp/storage.set", { context: request.context })).rejects.toMatchObject({ code: "migration_effect_denied" });
      return originalStart(request, reverse);
    };
    expect(await runStorageMigration(fixture.runner, input)).toEqual({ values: input.values });
    expect(fixture.contexts[0]).toMatchObject({ principalId: "owner", scopeId: "data-migration:private" });
    expect(calls[0]).toMatchObject({ method: "extension/dispatch", payload: { method: "migrate", input: { fromVersion: "1", toVersion: "2", values: input.values } } });
    expect(fixture.closed()).toBe(true);
    await expect(runStorageMigration(fixture.runner, { ...input, method: "undeclared" })).rejects.toMatchObject({ code: "migration_method_missing" });
    const invalid = candidateRunner(async () => ({}));
    await expect(runStorageMigration(invalid.runner, input)).rejects.toThrow();
    expect(invalid.closed()).toBe(true);
  });
  test("smoke error status assertions check both expected outcomes", async () => {
    for (const expected of [true, false]) {
      const candidate = structuredClone(release);
      candidate.manifest.tools![0]!.outputSchema = { type: "object" };
      candidate.manifest.smokeTest!.expect = { isError: expected };
      for (const actual of [true, false, undefined]) {
        const fixture = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : actual === undefined ? {} : { isError: actual });
        if ((actual === true) === expected) expect((await verifyExtensionCandidate(fixture.runner, candidate)).smoke).toBe("passed");
        else await expect(verifyExtensionCandidate(fixture.runner, candidate)).rejects.toMatchObject({ code: "smoke_assertion_failed" });
        expect(fixture.closed()).toBe(true);
      }
    }
  });
  test("text assertions inspect literal tool text rather than JSON-escaped transport", async () => {
    const candidate = structuredClone(release);
    candidate.manifest.tools![0]!.outputSchema = { type: "object" };
    candidate.manifest.smokeTest!.expect = { textIncludes: '\"ok\": true' };
    const fixture = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : { content: [{ type: "text", text: '{\n  \"ok\": true\n}' }] });
    expect((await verifyExtensionCandidate(fixture.runner, candidate)).smoke).toBe("passed");
    const invalid = candidateRunner(async (method) => method === "extension/discover" ? candidate.manifest : { content: [{ type: "image", text: '\"ok\": true' }] });
    await expect(verifyExtensionCandidate(invalid.runner, candidate)).rejects.toMatchObject({ code: "smoke_assertion_failed" });
  });
  test("checks runtime metadata and output using a separate verification identity", async () => {
    const fixture = candidateRunner(async (method) => method === "extension/discover" ? release.manifest : { text: "hello" });
    await verifyExtensionCandidate(fixture.runner, release);
    expect(fixture.closed()).toBe(true);
    expect(fixture.contexts[0]).toMatchObject({ principalId: "extension-verification", releaseId: release.id });
  });

  test("changed catalog and schema-invalid output fail and close the worker", async () => {
    const changed = candidateRunner(async () => ({ ...release.manifest, version: "2.0.0" }));
    await expect(verifyExtensionCandidate(changed.runner, release)).rejects.toMatchObject({ code: "runtime_catalog_mismatch" });
    expect(changed.closed()).toBe(true);
    const malformed = candidateRunner(async (method) => method === "extension/discover" ? release.manifest : { text: 123 });
    await expect(verifyExtensionCandidate(malformed.runner, release)).rejects.toThrow();
    expect(malformed.closed()).toBe(true);
  });

  test("sealed catalogs do not invent an undeclared smoke invocation", async () => {
    const manifest = structuredClone(release.manifest);
    delete manifest.smokeTest;
    const methods: string[] = [];
    const fixture = candidateRunner(async (method) => { methods.push(method); return manifest; });
    await verifyExtensionCandidate(fixture.runner, { ...release, manifest });
    expect(methods).toEqual(["extension/discover"]);
    expect(fixture.closed()).toBe(true);
  });
});
