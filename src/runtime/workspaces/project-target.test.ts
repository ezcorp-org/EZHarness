import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  closeTestDb,
  getTestDb,
  mockDbConnection,
  setupTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

const { createProject } = await import("../../db/queries/projects");
const { projectWorkspaceBindings, sandboxBindings } = await import("../../db/schema");
const { resolveLocalProjectTarget, resolveProjectWorkspaceTarget, setSandboxWorkspaceTargetResolver } = await import("./project-target");
const { localWorkspaceTarget, sandboxWorkspaceTarget } = await import("./target");

beforeAll(async () => setupTestDb(), 30_000);
afterAll(async () => {
  setSandboxWorkspaceTargetResolver(null);
  await closeTestDb();
});

describe("resolveLocalProjectTarget", () => {
  test("keeps an unbound project on its current local root", async () => {
    const project = await createProject({ name: "Local target", path: "/amd/local-project" });
    await expect(resolveLocalProjectTarget(project, "attachment read")).resolves.toEqual({
      kind: "local",
      root: "/amd/local-project",
    });
  });

  test("a durable sandbox binding denies AMD path fallback", async () => {
    const project = await createProject({ name: "Sandbox target", path: "/amd/canary-project" });
    await getTestDb().insert(sandboxBindings).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      providerInstallationId: "incus-provider",
      providerReleaseId: "release-1",
      connectionId: "connection-1",
      resourceKey: "workspace-1",
      desiredState: "RUNNING",
      observedState: "RUNNING",
      generation: 7,
    });

    await expect(resolveLocalProjectTarget(project, "attachment read"))
      .rejects.toThrow("Local workspace fallback was denied");
  });

  test("the existing sandbox binding also denies the provider route to AMD", async () => {
    const project = await createProject({ name: "Existing sandbox target", path: "/amd/other-canary" });
    await getTestDb().insert(projectWorkspaceBindings).values({
      projectId: project.id, kind: "sandbox", bindingId: "local-sandbox", state: "active", revision: 1,
    });
    await expect(resolveLocalProjectTarget(project, "attachment read"))
      .rejects.toThrow("Local workspace fallback was denied");
    await expect(resolveProjectWorkspaceTarget(project, "agent run", localWorkspaceTarget(project.path)))
      .rejects.toThrow("Local workspace fallback was denied");
  });

  test("a bound project accepts only its current in-process sandbox target", async () => {
    const project = await createProject({ name: "Bound target", path: "/amd/bound-project" });
    await getTestDb().insert(sandboxBindings).values({
      id: crypto.randomUUID(), projectId: project.id,
      providerInstallationId: "incus-provider", providerReleaseId: "release-1",
      connectionId: "connection-1", resourceKey: "workspace-2",
      desiredState: "RUNNING", observedState: "RUNNING", generation: 7,
    });
    const binding = {
      projectId: project.id, workspaceId: "workspace-2", connectionId: "connection-1",
      providerId: "incus", generation: 7, presetId: "isolated-feature",
      releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
      effectiveSettingsDigest: "c".repeat(64),
    };
    const target = sandboxWorkspaceTarget(binding, {
      async execute() { return { content: [], details: {} }; },
    });
    await expect(resolveProjectWorkspaceTarget(project, "agent run", target)).resolves.toBe(target);
    await expect(resolveProjectWorkspaceTarget(project, "agent run", localWorkspaceTarget(project.path)))
      .rejects.toThrow("Local workspace fallback was denied");
    await expect(resolveProjectWorkspaceTarget(project, "agent run", sandboxWorkspaceTarget({
      ...binding, generation: 8,
    }, target.backend))).rejects.toThrow("Local workspace fallback was denied");
    await expect(resolveProjectWorkspaceTarget(project, "agent run", sandboxWorkspaceTarget({
      ...binding, connectionId: "other-connection",
    }, target.backend))).rejects.toThrow("Local workspace fallback was denied");
  });

  test("resolves a persisted running binding through host injection and refuses a changed target", async () => {
    const project = await createProject({ name: "Host resolved", path: "/amd/resolver-canary" });
    const row = {
      id: crypto.randomUUID(), projectId: project.id,
      providerInstallationId: "incus-provider", providerReleaseId: "release-1",
      connectionId: "connection-1", resourceKey: "workspace-resolved",
      desiredState: "RUNNING" as const, observedState: "RUNNING" as const, generation: 3,
    };
    await getTestDb().insert(sandboxBindings).values(row);
    const qualified = {
      projectId: project.id, workspaceId: row.resourceKey, connectionId: row.connectionId,
      providerId: "incus", generation: row.generation, presetId: "feature",
      releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64),
    };
    const backend = { async execute() { return { content: [], details: {} }; } };
    const seen: string[] = [];
    setSandboxWorkspaceTargetResolver(async binding => {
      seen.push(binding.id);
      return sandboxWorkspaceTarget(qualified, backend);
    });
    const target = await resolveProjectWorkspaceTarget(project, "agent run", localWorkspaceTarget(project.path));
    expect(target).toEqual(sandboxWorkspaceTarget(qualified, backend));
    expect(seen).toEqual([row.id]);

    setSandboxWorkspaceTargetResolver(async () => sandboxWorkspaceTarget({ ...qualified, generation: 4 }, backend));
    await expect(resolveProjectWorkspaceTarget(project, "agent run"))
      .rejects.toThrow("Local workspace fallback was denied");
    setSandboxWorkspaceTargetResolver(null);
  });
});
