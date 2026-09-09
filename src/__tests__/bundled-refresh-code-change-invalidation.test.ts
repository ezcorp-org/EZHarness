// Current immutable lifecycle regression coverage retained at the original suite path.
import { expect, test } from "bun:test";
import { ExtensionLifecycle, actor, human, harness, releaseFixture } from "./helpers/durable-lifecycle-fixture";

test("release forks create independent revisions without replacing existing workspaces", async () => {
    const setup = await releaseFixture();
    const fork = await setup.lifecycle.createWorkspace(actor, { installationId: setup.installation.id, releaseId: setup.releaseId });
    expect(fork.workspace.id).not.toBe(setup.workspace.id);
    expect((await setup.lifecycle.readWorkspace(actor, setup.installation.id, fork.workspace.id)).files).toEqual({ "extension.ts": "export default 1", "src/nested.ts": "nested" });
    await setup.lifecycle.editWorkspace(actor, { installationId: setup.installation.id, workspaceId: fork.workspace.id, expectedRevision: 1, writes: { "extension.ts": "fork only" } });
    expect((await setup.lifecycle.readWorkspace(actor, setup.installation.id, setup.workspace.id)).files["extension.ts"]).toBe("export default 1");
    await setup.lifecycle.uninstall(human, setup.installation.id);
    await expect(setup.lifecycle.createWorkspace(actor, { installationId: setup.installation.id, releaseId: setup.releaseId })).rejects.toMatchObject({ code: "uninstalled" });
  });

test("source snapshots survive edits and idempotency binds exact inputs", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "before" } });
    const input = { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "same" };
    const operation = await setup.lifecycle.build(actor, input);
    await setup.lifecycle.editWorkspace(actor, { ...input, expectedRevision: 1, writes: { "extension.ts": "after" } });
    expect((await setup.lifecycle.build(actor, input)).id).toBe(operation.id);
    await expect(setup.lifecycle.build(actor, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(setup.builds).toEqual([{ "extension.ts": "before" }]);
    const restarted = new ExtensionLifecycle(setup.dependencies);
    expect((await restarted.inspect(actor, installation.id)).operations[operation.id]?.state).toBe("verified");
  });

test("nested edits are atomic; deletion is explicit; concurrent revisions conflict", async () => {
    const { lifecycle } = harness();
    const { installation, workspace } = await lifecycle.createWorkspace(actor, { files: { "extension.ts": "one", "src/remove.ts": "remove" } });
    const edits = await Promise.allSettled(["first", "second"].map((value) => lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, writes: { "src/nested/file.ts": value }, deletes: ["src/remove.ts"] })));
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((result) => result.status === "rejected")).toHaveLength(1);
    const result = await lifecycle.readWorkspace(actor, installation.id, workspace.id);
    expect(result.workspace.revision).toBe(2);
    expect(result.files["src/remove.ts"]).toBeUndefined();
    expect(result.files["src/nested/file.ts"]).toBeDefined();
    await expect(lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 2, writes: { "../escape.ts": "bad" } })).rejects.toMatchObject({ code: "invalid_path" });
    expect((await lifecycle.readWorkspace(actor, installation.id, workspace.id)).workspace.revision).toBe(2);
  });

test("binary assets preserve content and mode through immutable release forks", async () => {
  const setup = harness();
  const binary = { encoding: "base64" as const, data: "AP8=", executable: true };
  const files = { "extension.ts": "export default 1", "bin/asset": binary };
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "binary" });
  const release = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
  expect(release.state).toBe("verified");
  const fork = await setup.lifecycle.createWorkspace(actor, { installationId: installation.id, releaseId: release.releaseId! });
  expect((await setup.lifecycle.readWorkspace(actor, installation.id, fork.workspace.id)).files).toEqual(files);
  await setup.lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: fork.workspace.id, expectedRevision: 1, writes: { "bin/asset": { ...binary, executable: false } } });
  const edited = await setup.lifecycle.readWorkspace(actor, installation.id, fork.workspace.id);
  expect(edited.workspace.sourceDigest).not.toBe(workspace.sourceDigest);
  expect((await setup.lifecycle.readWorkspace(actor, installation.id, workspace.id)).files["bin/asset"]).toEqual(binary);
});

test("dependency resolution persists an exact revision and rejects concurrent edits", async () => {
  const setup = harness({ resolveDependencies: async files => ({ ...files, "package-lock.json": "locked", "extension.ts": "must not replace source" }) });
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "source" } });
  const input = { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1 };
  const resolved = await setup.lifecycle.resolveWorkspaceDependencies(actor, input);
  expect(resolved.revision).toBe(2);
  expect((await setup.lifecycle.readWorkspace(actor, installation.id, workspace.id)).files).toEqual({ "extension.ts": "source", "package-lock.json": "locked" });
  await expect(setup.lifecycle.build(actor, { ...input, idempotencyKey: "old-revision" })).rejects.toThrow("current workspace revision");
  await expect(setup.lifecycle.resolveWorkspaceDependencies(actor, input)).rejects.toThrow("Workspace changed");
  setup.dependencies.resolveDependencies = async files => {
    await setup.lifecycle.editWorkspace(actor, { ...input, expectedRevision: 2, writes: { "extension.ts": "new source" } });
    return { ...files, "package-lock.json": "stale lock" };
  };
  await expect(setup.lifecycle.resolveWorkspaceDependencies(actor, { ...input, expectedRevision: 2 })).rejects.toThrow("Workspace changed");
  expect((await setup.lifecycle.readWorkspace(actor, installation.id, workspace.id)).files["package-lock.json"]).toBe("locked");
  setup.dependencies.resolveDependencies = undefined;
  await expect(setup.lifecycle.resolveWorkspaceDependencies(actor, { ...input, expectedRevision: 3 })).rejects.toThrow("not configured");
  setup.dependencies.resolveDependencies = async () => ({});
  await setup.lifecycle.resolveWorkspaceDependencies(actor, { ...input, expectedRevision: 3 });
  expect((await setup.lifecycle.readWorkspace(actor, installation.id, workspace.id)).files["package-lock.json"]).toBeUndefined();
});
