import { describe, expect, test } from "bun:test";
import { actor, harness, human } from "./helpers/durable-lifecycle-fixture";
import type { LifecycleActor } from "../extensions/v4/types";

/**
 * The lifecycle's two human acknowledgement points for the trusted-local
 * (unsandboxed) mode, against the in-memory harness with the `trustedLocal`
 * dependency replaced by spies. What is pinned:
 *   - each point REFUSES without `acknowledgeUnsandboxed: true`
 *     (`unsandboxed_acknowledgement_required`) and records nothing;
 *   - with it, exactly one approval is recorded for the exact digest of the
 *     phase — the workspace's source digest at Build, the release's artifact
 *     digest at approve — attributed to the acting principal;
 *   - ordering: Build records BEFORE the operation exists (a moved revision
 *     records nothing), approve records only AFTER the decision commits and
 *     only for a yes;
 *   - revoke / disable / uninstall withdraw it;
 *   - with the dependency absent (isolated hosts) the flag is inert.
 * The runner-side enforcement of those records is the package's own test
 * (`trusted-local.test.ts`); the end-to-end join is
 * `trusted-local-runner-in-process.integration.test.ts`.
 */
type Recorded = { phase: "build" | "execute"; digest: string; installationId: string; approvedBy: string };

function trustedHarness() {
  const recorded: Recorded[] = [];
  const verifications: Array<{ installationId: string; sourceDigest: string; artifactDigest: string }> = [];
  const revoked: Array<[string, string | undefined]> = [];
  const setup = harness({
    trustedLocal: {
      async recordApproval(input) { recorded.push({ ...input }); },
      async recordVerificationApproval(input) { verifications.push({ ...input }); },
      async revokeApprovals(installationId, digest) { revoked.push([installationId, digest]); },
    },
  });
  return { ...setup, recorded, verifications, revoked };
}

async function verifiedRelease(setup: ReturnType<typeof trustedHarness>, by: LifecycleActor = actor) {
  const { installation, workspace } = await setup.lifecycle.createWorkspace(by, { files: { "extension.ts": "export default 1" } });
  const operation = await setup.lifecycle.build(by, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "build-1", acknowledgeUnsandboxed: true });
  await setup.lifecycle.runBuild(by, installation.id, operation.id);
  const state = await setup.lifecycle.inspect(by, installation.id);
  const releaseId = state.operations[operation.id]!.releaseId!;
  const release = state.releases[releaseId]!;
  const approval = await setup.lifecycle.requestApproval(by, { installationId: installation.id, releaseId, grants: [], expectedActiveReleaseId: null });
  return { installation, workspace, release, approval };
}

describe("Build — first acknowledgement point", () => {
  test("refuses without the acknowledgement and records nothing", async () => {
    const setup = trustedHarness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1" } });
    const input = { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "k" };
    await expect(setup.lifecycle.build(actor, input)).rejects.toMatchObject({ code: "unsandboxed_acknowledgement_required" });
    await expect(setup.lifecycle.build(actor, { ...input, acknowledgeUnsandboxed: false })).rejects.toMatchObject({ code: "unsandboxed_acknowledgement_required" });
    expect(setup.recorded).toEqual([]);
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).operations)).toEqual([]);
  });

  test("with it, records the exact source digest for the acting principal before the operation exists", async () => {
    const setup = trustedHarness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "k", acknowledgeUnsandboxed: true });
    expect(operation.sourceDigest).toBe(workspace.sourceDigest);
    expect(setup.recorded).toEqual([{ phase: "build", digest: workspace.sourceDigest, installationId: installation.id, approvedBy: actor.principalId }]);
  });

  test("a moved revision is refused before anything is recorded — the human saw a different source", async () => {
    const setup = trustedHarness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "before" } });
    await setup.lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, writes: { "extension.ts": "after" } });
    await expect(setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "k", acknowledgeUnsandboxed: true })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(setup.recorded).toEqual([]);
  });

  test("the harness runner still receives the build, and the release is verified", async () => {
    const setup = trustedHarness();
    const { release } = await verifiedRelease(setup);
    expect(setup.builds).toEqual([{ "extension.ts": "export default 1" }]);
    expect(release.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("before verifying the candidate, the build acknowledgement is extended to the artifact it produced", async () => {
    const setup = trustedHarness();
    const { installation, workspace, release } = await verifiedRelease(setup);
    // Exactly once, for exactly this build's source → artifact pair, and only
    // after the runner produced the artifact (so never for a failed build).
    expect(setup.verifications).toEqual([{ installationId: installation.id, sourceDigest: workspace.sourceDigest, artifactDigest: release.artifactDigest }]);
    // It is derived, not a second human acknowledgement: `recordApproval`
    // saw only the build.
    expect(setup.recorded.map((entry) => entry.phase)).toEqual(["build"]);
  });
});

describe("Approve exact release — second acknowledgement point", () => {
  test("a yes without the acknowledgement is refused, decided nothing, recorded nothing", async () => {
    const setup = trustedHarness();
    const { installation, approval } = await verifiedRelease(setup);
    setup.recorded.length = 0;
    await expect(setup.lifecycle.approve(human, installation.id, approval.id, true)).rejects.toMatchObject({ code: "unsandboxed_acknowledgement_required" });
    await expect(setup.lifecycle.approve(human, installation.id, approval.id, true, { acknowledgeUnsandboxed: false })).rejects.toMatchObject({ code: "unsandboxed_acknowledgement_required" });
    expect((await setup.lifecycle.inspect(human, installation.id)).approvals[approval.id]?.status).toBe("pending");
    expect(setup.recorded).toEqual([]);
  });

  test("a yes with it records the exact artifact digest after the decision commits", async () => {
    const setup = trustedHarness();
    const { installation, release, approval } = await verifiedRelease(setup);
    setup.recorded.length = 0;
    const decided = await setup.lifecycle.approve(human, installation.id, approval.id, true, { acknowledgeUnsandboxed: true });
    expect(decided.status).toBe("approved");
    expect(decided.approvedBy).toBe(human.principalId);
    expect(setup.recorded).toEqual([{ phase: "execute", digest: release.artifactDigest, installationId: installation.id, approvedBy: human.principalId }]);
  });

  test("a no never needs the acknowledgement and records nothing", async () => {
    const setup = trustedHarness();
    const { installation, approval } = await verifiedRelease(setup);
    setup.recorded.length = 0;
    expect((await setup.lifecycle.approve(human, installation.id, approval.id, false)).status).toBe("rejected");
    expect(setup.recorded).toEqual([]);
  });

  test("a stale approval is still refused as stale, not upgraded by the acknowledgement", async () => {
    const setup = trustedHarness();
    const { installation, approval } = await verifiedRelease(setup);
    // Reject it first; a second decision is `approval_decided` regardless.
    await setup.lifecycle.approve(human, installation.id, approval.id, false);
    await expect(setup.lifecycle.approve(human, installation.id, approval.id, true, { acknowledgeUnsandboxed: true })).rejects.toMatchObject({ code: "approval_decided" });
  });
});

describe("withdrawal", () => {
  test("revoking an approval withdraws exactly that installation's copy of the artifact digest", async () => {
    const setup = trustedHarness();
    const { installation, release, approval } = await verifiedRelease(setup);
    await setup.lifecycle.approve(human, installation.id, approval.id, true, { acknowledgeUnsandboxed: true });
    await setup.lifecycle.revokeApproval(human, installation.id, approval.id);
    expect(setup.revoked).toEqual([[installation.id, release.artifactDigest]]);
  });

  test("disable and uninstall withdraw everything the installation holds", async () => {
    const setup = trustedHarness();
    const { installation } = await verifiedRelease(setup);
    await setup.lifecycle.disable(human, installation.id);
    await setup.lifecycle.uninstall(human, installation.id);
    expect(setup.revoked).toEqual([[installation.id, undefined], [installation.id, undefined]]);
  });
});

describe("isolated hosts — the dependency is absent", () => {
  test("the flag is inert: builds and approvals proceed exactly as before", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: "k", acknowledgeUnsandboxed: false });
    await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    const state = await setup.lifecycle.inspect(actor, installation.id);
    const approval = await setup.lifecycle.requestApproval(actor, { installationId: installation.id, releaseId: state.operations[operation.id]!.releaseId!, grants: [], expectedActiveReleaseId: null });
    expect((await setup.lifecycle.approve(human, installation.id, approval.id, true)).status).toBe("approved");
    await expect(setup.lifecycle.revokeApproval(human, installation.id, approval.id)).resolves.toMatchObject({ status: "revoked" });
  });
});
