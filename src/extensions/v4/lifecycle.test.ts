import { up as addSandboxController } from "../../db/migrations/add-sandbox-controller";
import { database, drizzle, repository } from "../../__tests__/helpers/durable-lifecycle-fixture";
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

  const expiredActivation = sandboxLifecycleHarness();
  const expiringRelease = await releaseFixture(expiredActivation);
  const approvedInput = await approved(expiringRelease);
  expiredActivation.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(expiredActivation.lifecycle.activate(actor, approvedInput)).rejects.toMatchObject({ code: "INVALID_QUALIFICATION" });
  expect((await expiredActivation.lifecycle.inspect(actor, expiringRelease.installation.id)).installation.enabled).toBe(false);
});

test("sandbox reconciliation retries publication after candidate expiry", async () => {
  let publications = 0;
  const setup = sandboxLifecycleHarness();
  setup.dependencies.publish = async () => { publications++; if (publications === 1) throw new Error("publication interrupted"); };
  const built = await releaseFixture(setup);
  const activation = await setup.lifecycle.activate(actor, await approved(built));
  expect(activation.state).toBe("reconciling");
  expect(publications).toBe(1);
  setup.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(setup.lifecycle.reconcile(actor, built.installation.id)).resolves.toBeUndefined();
  expect(publications).toBe(2);
  expect((await setup.lifecycle.inspect(actor, built.installation.id)).installation.status).toBe("active");
});

test("sandbox reconciliation accepts expired candidate evidence after publication was acknowledged", async () => {
  const setup = sandboxLifecycleHarness();
  const built = await releaseFixture(setup);
  const activation = await setup.lifecycle.activate(actor, await approved(built));
  expect(activation.state).toBe("active");
  setup.clock.now = Date.parse("2026-09-21T13:00:00.000Z");
  await expect(setup.lifecycle.reconcile(actor, built.installation.id)).resolves.toBeUndefined();
});


test("provider release update retains the active release until its sandbox is drained", async () => {
  await database.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY)");
  await addSandboxController(drizzle(database));
  await expect(repository.assertProviderReleaseDrained("missing-installation", "next-release")).rejects.toMatchObject({ code: "not_found" });
  const setup = sandboxLifecycleHarness();
  const first = await releaseFixture(setup);
  expect((await setup.lifecycle.activate(actor, await approved(first))).state).toBe("active");
  const projectId = `${first.installation.id}-project`;
  await database.query("INSERT INTO projects (id) VALUES ($1)", [projectId]);
  await database.query(`INSERT INTO sandbox_bindings (id,project_id,provider_installation_id,provider_release_id,connection_id,desired_state,observed_state)
    VALUES ($1,$1,$2,$3,'connection','STOPPED','STOPPED')`, [projectId, first.installation.id, first.releaseId]);
  const build = await setup.lifecycle.build(actor, { installationId: first.installation.id, workspaceId: first.workspace.id, expectedRevision: 1, idempotencyKey: "second-build" });
  const second = await setup.lifecycle.runBuild(actor, first.installation.id, build.id);
  let preparations = 0;
  setup.dependencies.prepareActivation = async installation => {
    await repository.assertProviderReleaseDrained(installation.id, second.releaseId!);
    preparations += 1;
  };
  const update = await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "update"));
  expect(update.state).toBe("failed");
  expect(preparations).toBe(0);
  expect((await setup.lifecycle.inspect(actor, first.installation.id)).installation.activeReleaseId).toBe(first.releaseId);
  for (const observed of ["RUNNING", "UNKNOWN"]) {
    await database.query("UPDATE sandbox_bindings SET observed_state=$1 WHERE id=$2", [observed, projectId]);
    expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, `update-${observed}`))).state).toBe("failed");
  }
  await database.query("UPDATE sandbox_bindings SET desired_state='ABSENT', observed_state='ABSENT', tombstoned_at=NOW(), cleanup_confirmed_at=NOW() WHERE id=$1", [projectId]);
  await database.query(`INSERT INTO provider_sandbox_operations (id,binding_id,kind,generation,idempotency_scope,idempotency_key,payload_hash,request_payload,state)
    VALUES ($1,$1,'DESTROY',1,'test','destroy','hash','{}','OUTCOME_UNKNOWN')`, [projectId]);
  expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "unknown-cleanup"))).state).toBe("failed");
  await database.query("UPDATE provider_sandbox_operations SET state='SUCCEEDED' WHERE id=$1", [projectId]);
  await database.query(`INSERT INTO sandbox_host_capacities VALUES ($1,'connection',10,10,10,10,10,0,0,0,0,0,NOW())`, [first.installation.id]);
  await database.query(`INSERT INTO sandbox_reservations (binding_id,project_id,provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,pids,disk_bytes,execution_slots,compute_state,disk_state)
    VALUES ($1,$1,$2,'connection',1,1,1,1,1,1,'RELEASED','RELEASE_REQUESTED')`, [projectId, first.installation.id]);
  expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "unreleased-disk"))).state).toBe("failed");
  await database.query("UPDATE sandbox_reservations SET disk_state='RELEASED', compute_state='RELEASE_REQUESTED' WHERE binding_id=$1", [projectId]);
  expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "unreleased-compute"))).state).toBe("failed");
  await database.query("UPDATE sandbox_reservations SET compute_state='RELEASED' WHERE binding_id=$1", [projectId]);
  setup.dependencies.prepareActivation = async installation => {
    await repository.assertProviderReleaseDrained(installation.id, second.releaseId!);
    await database.query("UPDATE sandbox_bindings SET observed_state='UNKNOWN' WHERE id=$1", [projectId]);
  };
  expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "changed-after-preflight"))).state).toBe("failed");
  expect((await setup.lifecycle.inspect(actor, first.installation.id)).installation.activeReleaseId).toBe(first.releaseId);
  await database.query("UPDATE sandbox_bindings SET observed_state='ABSENT' WHERE id=$1", [projectId]);
  setup.dependencies.prepareActivation = async installation => {
    await repository.assertProviderReleaseDrained(installation.id, second.releaseId!);
    preparations += 1;
  };
  expect((await setup.lifecycle.activate(actor, await approved({ ...first, releaseId: second.releaseId! }, "drained"))).state).toBe("active");
  expect((await setup.lifecycle.inspect(actor, first.installation.id)).installation.activeReleaseId).toBe(second.releaseId!);
  expect(preparations).toBe(1);
  await database.query("UPDATE sandbox_bindings SET desired_state='RUNNING', observed_state='RUNNING', tombstoned_at=NULL, cleanup_confirmed_at=NULL WHERE id=$1", [projectId]);
  expect((await setup.lifecycle.disable(human, first.installation.id)).enabled).toBe(false);
});
