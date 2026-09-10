// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { MAX_FRAME_BYTES } from "@ezcorp/extension-contract/json";
import aiKitManifest from "../../packages/@ezcorp/ai-kit/ezcorp.config";
import { requestedReleaseGrants } from "../extensions/bundled-drift-reapprove";
import { digestObject, actor, human, repository, harness, releaseFixture, approved } from "./helpers/durable-lifecycle-fixture";

test("cross-user and cross-scope state is inaccessible including approval and fork", async () => {
    const setup = await releaseFixture();
    for (const foreign of [{ ...actor, principalId: "other" }, { ...actor, scope: "project:two" }]) {
      await expect(setup.lifecycle.inspect(foreign, setup.installation.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(setup.lifecycle.createWorkspace(foreign, { installationId: setup.installation.id, releaseId: setup.releaseId })).rejects.toMatchObject({ code: "not_found" });
      expect(await setup.lifecycle.list(foreign)).toEqual([]);
    }
  });

test("independent candidate coverage is immutable and bound into the release digest", async () => {
    const verification = { catalog: "verified" as const, smoke: "not_declared" as const, capabilities: [{ capability: "storage", state: "unexercised" as const, calls: 0 }] };
    const setup = await releaseFixture(harness({ verifyCandidate: async () => verification }));
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    const release = state.releases[setup.releaseId]!;
    expect(release.verification).toEqual(verification);
    const { id: _id, createdAt: _createdAt, releaseDigest, ...input } = release;
    expect(releaseDigest).toBe(digestObject(input));
    const { verification: _verification, ...withoutCoverage } = input;
    expect(releaseDigest).not.toBe(digestObject(withoutCoverage));
  });

test("database refuses release mutation and record deletion", async () => {
    const setup = await releaseFixture();
    await expect(repository.transact(setup.installation.id, (state) => { state.releases[setup.releaseId]!.artifactDigest = "changed"; })).rejects.toMatchObject({ code: "immutable_release" });
    await expect(repository.transact(setup.installation.id, (state) => { delete state.releases[setup.releaseId]; })).rejects.toMatchObject({ code: "retention_required" });
  });

test("concurrent activation admits only one live lease", async () => {
    const setup = await releaseFixture();
    const first = await approved(setup, "first");
    const second = await approved(setup, "second");
    let started = false;
    let unblock: () => void = () => {};
    setup.dependencies.verifyCandidate = async () => { started = true; await new Promise<void>((resolve) => { unblock = resolve; }); };
    const running = setup.lifecycle.activate(actor, first);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(setup.lifecycle.activate(actor, second)).rejects.toMatchObject({ code: "activation_busy" });
    unblock();
    expect((await running).state).toBe("active");
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
  });

test.each([
  { name: "duplicate grants", grants: ["storage:write", "events:read", "storage:write"], expected: ["events:read", "storage:write"] },
  { name: "bundled AI-kit host API permissions", grants: requestedReleaseGrants(aiKitManifest), expected: requestedReleaseGrants(aiKitManifest) },
])("capability review preserves $name until human approval and activation", async ({ grants, expected }) => {
  const fixture = harness();
  const build = fixture.dependencies.runner.build;
  fixture.dependencies.runner.build = async (request) => {
    const result = await build(request);
    if (result.state !== "succeeded") throw new Error("fixture build must succeed");
    const manifest = { ...result.manifest, permissions: aiKitManifest.permissions };
    return { ...result, manifest, evidence: { ...result.evidence, discoveryDigest: digestObject(manifest) } };
  };
  const setup = await releaseFixture(fixture);
  const requested = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [...grants], expectedActiveReleaseId: null });
  expect(requested.grants).toEqual([...expected]);
  expect(requested.status).toBe("pending");
  expect(requested.releaseId).toBe(setup.releaseId);
  expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.grants).toEqual([]);
  await setup.lifecycle.approve(human, setup.installation.id, requested.id, true);
  expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.enabled).toBe(false);
  const operation = await setup.lifecycle.activate(actor, { installationId: setup.installation.id, approvalId: requested.id, idempotencyKey: "reviewed-capabilities" });
  expect(operation.state).toBe("active");
  expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.grants).toEqual(requested.grants);
});

test("invalid capability lists cannot create pending review records", async () => {
  const setup = await releaseFixture();
  const request = (grants: unknown) => setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: grants as string[], expectedActiveReleaseId: null });
  await expect(request("storage:read")).rejects.toMatchObject({ code: "invalid_grants" });
  await expect(request([false])).rejects.toMatchObject({ code: "invalid_grants" });
  await expect(request([""])).rejects.toMatchObject({ code: "invalid_grants" });
  await expect(request(["x".repeat(MAX_FRAME_BYTES)])).rejects.toMatchObject({ code: "invalid_grants" });
  await expect(request(Array(1001).fill("storage:read"))).rejects.toMatchObject({ code: "invalid_grants" });
  await expect(request(["é".repeat(MAX_FRAME_BYTES / 4), "ø".repeat(MAX_FRAME_BYTES / 4)])).rejects.toMatchObject({ code: "invalid_grants" });
  expect((await setup.lifecycle.inspect(actor, setup.installation.id)).approvals).toEqual({});
});
