import { expect, test } from "bun:test";
import { CANDIDATE_SANDBOX_QUALIFICATION_CASES, sandboxPresetDigest, type CandidateVerificationReport, type ReleaseRecord } from "@ezcorp/extension-contract";
import { actor, approved, chmod, rm, symlink, writeFile, join, workspaceText, canonicalJson, FileBlobStore, getFiles, putFiles, runnerBusyRetryMs, root, blobs, digestObject, harness, human, releaseFixture } from "../../__tests__/helpers/durable-lifecycle-fixture";
import { sandboxPresetQualificationReleaseDigest } from "./sandbox-preset-qualification";
import { sandboxProviderDeclaration, sandboxTestDigest } from "../../__tests__/helpers/sandbox-preset";

const qualificationNow = Date.parse("2026-09-21T12:00:00.000Z");
function sandboxLifecycleHarness() {
  const clock = { now: qualificationNow };
  const setup = harness({ now: () => clock.now });
  const build = setup.dependencies.runner.build;
  setup.dependencies.runner.build = async request => {
    const result = await build(request);
    if (!result.manifest) throw new Error("Expected fixture manifest");
    const manifest = {
      ...result.manifest,
      sandboxProviders: [sandboxProviderDeclaration({ helperDigests: [sandboxTestDigest("3")] })],
    };
    return { ...result, manifest, evidence: { ...result.evidence, discoveryDigest: digestObject(manifest) } };
  };
  const report = async (release: ReleaseRecord, status: "passed" | "failed" = "passed"): Promise<CandidateVerificationReport> => {
    const preset = release.manifest.sandboxProviders![0]!.presets[0]!;
    return {
      catalog: "verified", smoke: "not_declared", capabilities: [],
      sandboxPresetQualifications: [{
        producer: "host", providerId: "incus", presetId: preset.id, profile: preset.profile,
        releaseDigest: sandboxPresetQualificationReleaseDigest(release), presetDigest: await sandboxPresetDigest(preset),
        verifiedAt: "2026-09-21T11:00:00.000Z", validUntil: "2026-09-21T13:00:00.000Z",
        cases: CANDIDATE_SANDBOX_QUALIFICATION_CASES.map((caseId, index) => ({ caseId, status: index === 0 ? status : "passed" })),
      }],
    };
  };
  setup.dependencies.verifyCandidate = release => report(release);
  return { ...setup, clock, report };
}

test("runner-busy backpressure grows to its bounded durable maximum", () => {
    expect([runnerBusyRetryMs(1), runnerBusyRetryMs(2), runnerBusyRetryMs(6), runnerBusyRetryMs(99)]).toEqual([1_000, 2_000, 30_000, 30_000]);
  });

test("compiled artifacts can exceed source limits without relaxing workspace admission", async () => {
    const files = { "extension.js": "x".repeat(21 * 1024 * 1024) };
    await expect(putFiles(blobs, files)).rejects.toThrow();
    const digest = await putFiles(blobs, files, "artifact");
    expect(workspaceText((await getFiles(blobs, digest, "artifact"))["extension.js"], "extension.js").length).toBe(files["extension.js"].length);
    await expect(getFiles(blobs, digest)).rejects.toThrow();
  });

test("concurrent identical writes are content addressed and tampering fails", async () => {
    const bytes = new TextEncoder().encode(canonicalJson({ "file.ts": "one" }));
    const results = await Promise.all([blobs.put(bytes), blobs.put(bytes)]);
    expect(results[0]).toBe(results[1]);
    expect(await blobs.get(results[0]!)).toEqual(bytes);
    await expect(writeFile(join(root, results[0]!), "corrupt")).rejects.toThrow();
    await chmod(join(root, results[0]!), 0o600);
    await writeFile(join(root, results[0]!), "corrupt");
    await expect(blobs.get(results[0]!)).rejects.toMatchObject({ code: "artifact_corrupt" });
  });

test("a missing real blob is reported as an unavailable artifact", async () => {
  await expect(blobs.get("a".repeat(64))).rejects.toMatchObject({ code: "artifact_missing" });
});

test("symlink objects and roots are refused", async () => {
    const target = join(root, "target");
    await writeFile(target, "secret");
    await symlink(target, join(root, "e".repeat(64)));
    await expect(blobs.get("e".repeat(64))).rejects.toThrow();
    await expect(blobs.get("e".repeat(64))).rejects.not.toMatchObject({ code: "artifact_missing" });
    const linkRoot = `${root}-link`;
    await symlink(root, linkRoot);
    try { await expect(new FileBlobStore(linkRoot).put(new Uint8Array())).rejects.toMatchObject({ code: "unsafe_blob_root" }); } finally { await rm(linkRoot); }
  });

test("sandbox builds fail closed before storing an unqualified release", async () => {
  const setup = sandboxLifecycleHarness();
  setup.dependencies.verifyCandidate = async () => ({ catalog: "verified", smoke: "not_declared", capabilities: [] });
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "sandbox-build-denial" });
  expect((await setup.lifecycle.runBuild(actor, installation.id, operation.id)).state).toBe("failed");
  expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(0);
});

test("sandbox approval and activation require current stored and freshly verified evidence", async () => {
  const setup = sandboxLifecycleHarness();
  const built = await releaseFixture(setup);
  const approvalInput = await approved(built);
  setup.dependencies.verifyCandidate = release => setup.report(release, "failed");
  expect((await setup.lifecycle.activate(actor, approvalInput)).state).toBe("failed");
  expect((await setup.lifecycle.inspect(actor, built.installation.id)).installation.enabled).toBe(false);

  const stale = sandboxLifecycleHarness();
  const staleBuild = await releaseFixture(stale);
  const state = await stale.lifecycle.inspect(actor, staleBuild.installation.id);
  const approval = await stale.lifecycle.requestApproval(actor, { installationId: staleBuild.installation.id, releaseId: staleBuild.releaseId, grants: ["storage:read"], expectedActiveReleaseId: null });
  stale.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(stale.lifecycle.approve(human, staleBuild.installation.id, approval.id, true)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  expect((await stale.lifecycle.inspect(actor, staleBuild.installation.id)).approvals[approval.id]!.status).toBe("pending");
  expect(state.installation.enabled).toBe(false);
});

test("sandbox reconciliation rechecks qualification before retrying publication", async () => {
  let publications = 0;
  const setup = sandboxLifecycleHarness();
  setup.dependencies.publish = async () => { publications++; if (publications === 1) throw new Error("publication interrupted"); };
  const built = await releaseFixture(setup);
  const activation = await setup.lifecycle.activate(actor, await approved(built));
  expect(activation.state).toBe("reconciling");
  expect(publications).toBe(1);
  setup.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(setup.lifecycle.reconcile(actor, built.installation.id)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  expect(publications).toBe(1);
});

test("sandbox reconciliation rechecks expired evidence after publication was acknowledged", async () => {
  const setup = sandboxLifecycleHarness();
  const built = await releaseFixture(setup);
  const activation = await setup.lifecycle.activate(actor, await approved(built));
  expect(activation.state).toBe("active");
  setup.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(setup.lifecycle.reconcile(actor, built.installation.id)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
});
