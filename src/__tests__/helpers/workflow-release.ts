import type { WorkflowDefinition } from "../../types";
import type { CachedWorkflow } from "../../runtime/workflow-scope";
import { releaseBinding, type ActiveExtensionRelease } from "../../extensions/release-process";
import { releaseRuntimeFixture } from "./release-runtime";

export function workflowReleaseFixture(definition: WorkflowDefinition, ownerId: string, installationId: string = crypto.randomUUID(), options?: Parameters<typeof releaseRuntimeFixture>[2]) {
  const runtime = releaseRuntimeFixture(installationId, {
    schemaVersion: 4,
    name: definition.name.split(":")[0]!,
    version: "1.0.0",
    description: "Workflow authority fixture",
    author: { name: "Fixture owner" },
    entrypoint: "extension.ts",
    permissions: {},
    tools: [],
  }, { ...options, ownerId });
  const entry = workflowReleaseEntry(definition, runtime.snapshot);
  runtime.configure();
  return { ...runtime, entry };
}

export function workflowReleaseEntry(definition: WorkflowDefinition, snapshot: ActiveExtensionRelease): CachedWorkflow {
  const { ownerId, scope, id: installationId } = snapshot.installation;
  return {
    definition, source: "extension", id: null, userId: ownerId,
    projectId: null, visibility: "private", forkedFrom: null,
    extensionRelease: { installationId, binding: releaseBinding(snapshot), ownerId, scope },
  };
}
