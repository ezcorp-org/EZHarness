import type { ExtensionManifestV4, WorkspaceFiles } from "@ezcorp/extension-contract";
import { scaffoldWorkspace } from "@ezcorp/sdk/scaffold";
import { canonicalJson, compileValueSchema, validateWorkspaceFiles, WORKSPACE_FILE_SCHEMA } from "@ezcorp/extension-contract";
import type { ExtensionLifecycle } from "./v4";
import type { LifecycleActor, InstallationState } from "./v4/types";
import { extensionLogger } from "../logger";
import { inspectRuntimeLocks, recoverRuntimeLock } from "./runtime-locks";

const log = extensionLogger("author", "control");
const identifier = { type: "string", minLength: 1, maxLength: 128 };
const filesSchema = { type: "object", additionalProperties: WORKSPACE_FILE_SCHEMA };
const commonProperties = { installationId: identifier };

export const extensionControlTools = [
  { name: "extensions_describe", description: "Read the extension SDK, available features, authoring example and release rules.", properties: {}, required: [] },
  { name: "extensions_workspace", description: "Create, inspect or atomically edit an extension workspace. Edits require the last observed revision. Nested files are supported. After changing package dependencies, use resolveDependencies to save the exact lockfile in a new revision before building.", properties: { ...commonProperties, action: { enum: ["create", "list", "read", "edit", "fork", "resolveDependencies"] }, workspaceId: identifier, releaseId: identifier, expectedRevision: { type: "integer", minimum: 0 }, writes: filesSchema, deletes: { type: "array", items: { type: "string" } }, name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }, description: { type: "string", maxLength: 1000 } }, required: ["action"] },
  { name: "extensions_build", description: "Build and verify an exact workspace revision in the isolated runner. Returns a durable operation; inspect it for errors before requesting release approval.", properties: { ...commonProperties, workspaceId: identifier, expectedRevision: { type: "integer", minimum: 0 }, idempotencyKey: identifier, entrypoint: { type: "string", maxLength: 512 } }, required: ["installationId", "workspaceId", "expectedRevision", "idempotencyKey"] },
  { name: "extensions_inspect", description: "Read extension workspaces, releases, checks, approvals and operation status. An operationId with waitMs waits for a terminal build state, with a maximum of five minutes.", properties: { ...commonProperties, locks: { type: "boolean" }, operationId: identifier, waitMs: { type: "integer", minimum: 0, maximum: 300000 } }, required: ["installationId"] },
  { name: "extensions_release", description: "Request human approval for the exact tested release, activate an approved release, roll back, disable or uninstall. This tool cannot approve code or permissions. Uninstall retains data.", properties: { ...commonProperties, action: { enum: ["requestApproval", "activate", "rollback", "disable", "uninstall", "recoverLock"] }, lockKey: identifier, expectedFence: identifier, acknowledgeUncertainEffects: { type: "boolean" }, releaseId: identifier, approvalId: identifier, expectedActiveReleaseId: { anyOf: [identifier, { type: "null" }] }, idempotencyKey: identifier }, required: ["action", "installationId"] },
] as const;

export type ExtensionControlTool = (typeof extensionControlTools)[number]["name"];

const inputValidators = new Map(extensionControlTools.map((tool) => [tool.name, compileValueSchema({ type: "object", properties: tool.properties, required: tool.required, additionalProperties: false }, tool.name === "extensions_workspace" ? 128 * 1024 * 1024 : undefined)]));

export class ExtensionControlError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ExtensionControlError";
  }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new ExtensionControlError("invalid_input", `${key} must be a non-empty string.`);
  return value;
}

function expectedRevision(input: Record<string, unknown>): number {
  const value = input.expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ExtensionControlError("invalid_input", "expectedRevision must be a non-negative integer.");
  return value;
}

function sourceFiles(value: unknown): WorkspaceFiles | undefined {
  if (value === undefined) return undefined;
  return validateWorkspaceFiles(value);
}

export function requestedReleaseGrants(manifest: ExtensionManifestV4): string[] {
  const permissions = { ...manifest.permissions, ...(manifest.acceptsCallerCaps === undefined ? {} : { acceptsCallerCaps: manifest.acceptsCallerCaps }), ...(manifest.escalateChildCaps === undefined ? {} : { escalateChildCaps: manifest.escalateChildCaps }) };
  return Object.entries(permissions).map(([name, value]) => canonicalJson([name, value])).sort();
}

export function createExtensionFiles(name = "my-extension", description = "A new extension"): WorkspaceFiles {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new ExtensionControlError("invalid_name", "Use a lowercase extension name with letters, numbers and hyphens.");
  return scaffoldWorkspace({ name, description }).files;
}

export class ExtensionControl {
  constructor(private readonly lifecycle: ExtensionLifecycle) {}

  async execute(actor: LifecycleActor, tool: ExtensionControlTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const validate = inputValidators.get(tool);
    if (!validate) throw new ExtensionControlError("unknown_tool", "Unknown extension control tool.");
    try { validate(input); } catch (cause) { throw new ExtensionControlError("invalid_input", cause instanceof Error ? cause.message : "Invalid input."); }
    if (tool === "extensions_describe") return {
      schemaVersion: 4,
      sdk: "@ezcorp/sdk/v4",
      entrypoint: "extension.ts",
      template: createExtensionFiles(),
      features: ["tools", "skills", "agents", "workflows", "pages", "entities", "settings", "secrets", "storage", "files", "events", "schedules", "loops", "webhooks", "attachments", "MCP"],
      flow: ["extensions_workspace", "extensions_build", "extensions_inspect", "extensions_release"],
      rules: ["Read the current revision before editing.", "Use ctx.call for host capabilities.", "Feature tests belong to the builder; host security checks cannot be changed.", "A human must approve the exact tested release.", "An installed record does not prove a working extension."],
    };
    if (tool === "extensions_workspace") return this.workspace(actor, input);
    const installationId = requiredString(input, "installationId");
    if (tool === "extensions_build") {
      const operation = await this.lifecycle.build(actor, { installationId, workspaceId: requiredString(input, "workspaceId"), expectedRevision: expectedRevision(input), idempotencyKey: requiredString(input, "idempotencyKey"), ...(input.entrypoint === undefined ? {} : { entrypoint: requiredString(input, "entrypoint") }) });
      void this.lifecycle.runBuild(actor, installationId, operation.id).catch((error: unknown) => log.error("Extension build worker failed", { installationId, operationId: operation.id, error: error instanceof Error ? error.message : String(error) }));
      return operation;
    }
    if (tool === "extensions_inspect") return this.inspect(actor, installationId, input, signal);
    if (tool !== "extensions_release") throw new ExtensionControlError("unknown_tool", "Unknown extension control tool.");
    const action = requiredString(input, "action");
    if (action === "recoverLock") {
      await this.lifecycle.inspect(actor, installationId);
      await recoverRuntimeLock(actor, installationId, input.lockKey, input.expectedFence, input.acknowledgeUncertainEffects);
      return { recovered: true };
    }
    if (action === "requestApproval") {
      const releaseId = requiredString(input, "releaseId");
      const state = await this.lifecycle.inspect(actor, installationId);
      const release = state.releases[releaseId];
      if (!release) throw new ExtensionControlError("not_found", "Release not found.");
      if (input.expectedActiveReleaseId !== null && typeof input.expectedActiveReleaseId !== "string") throw new ExtensionControlError("invalid_input", "expectedActiveReleaseId must be the observed release ID or null.");
      const approval = await this.lifecycle.requestApproval(actor, { installationId, releaseId, grants: requestedReleaseGrants(release.manifest), expectedActiveReleaseId: input.expectedActiveReleaseId });
      return { approval, openUrl: `/extensions/author?installation=${encodeURIComponent(installationId)}` };
    }
    if (action === "activate" || action === "rollback") return this.lifecycle[action](actor, { installationId, approvalId: requiredString(input, "approvalId"), idempotencyKey: requiredString(input, "idempotencyKey") });
    if (action === "disable" || action === "uninstall") return this.lifecycle[action](actor, installationId);
    throw new ExtensionControlError("invalid_action", "Unknown release action. Approval is only available to a human session.");
  }

  private async workspace(actor: LifecycleActor, input: Record<string, unknown>): Promise<unknown> {
    const action = requiredString(input, "action");
    if (action === "list") return this.lifecycle.list(actor);
    if (action === "create" || action === "fork") {
      const result = await this.lifecycle.createWorkspace(actor, action === "fork" ? { installationId: requiredString(input, "installationId"), releaseId: requiredString(input, "releaseId") } : { files: sourceFiles(input.writes) ?? createExtensionFiles(typeof input.name === "string" ? input.name : undefined, typeof input.description === "string" ? input.description : undefined) });
      return { ...result, openUrl: `/extensions/author?installation=${encodeURIComponent(result.installation.id)}&workspace=${encodeURIComponent(result.workspace.id)}` };
    }
    const installationId = requiredString(input, "installationId");
    const workspaceId = requiredString(input, "workspaceId");
    if (action === "read") return this.lifecycle.readWorkspace(actor, installationId, workspaceId);
    if (action === "resolveDependencies") return this.lifecycle.resolveWorkspaceDependencies(actor, { installationId, workspaceId, expectedRevision: expectedRevision(input) });
    if (action !== "edit") throw new ExtensionControlError("invalid_action", "Unknown workspace action.");
    if (input.deletes !== undefined && (!Array.isArray(input.deletes) || input.deletes.some((value) => typeof value !== "string"))) throw new ExtensionControlError("invalid_input", "deletes must be a list of file paths.");
    return this.lifecycle.editWorkspace(actor, { installationId, workspaceId, expectedRevision: expectedRevision(input), writes: sourceFiles(input.writes), deletes: input.deletes as string[] | undefined });
  }

  private async inspect(actor: LifecycleActor, installationId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<InstallationState & { locks?: Awaited<ReturnType<typeof inspectRuntimeLocks>> }> {
    const waitMs = input.waitMs ?? 0;
    if (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 300000) throw new ExtensionControlError("invalid_input", "waitMs must be between 0 and 300000.");
    const deadline = performance.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      const state = await this.lifecycle.inspect(actor, installationId);
      if (input.operationId === undefined) return input.locks === true ? { ...state, locks: await inspectRuntimeLocks(installationId) } : state;
      const operation = state.operations[requiredString(input, "operationId")];
      if (!operation) throw new ExtensionControlError("not_found", "Operation not found.");
      if (!["queued", "building", "verifying", "activating"].includes(operation.state) || performance.now() >= deadline) return state;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))));
    }
  }
}
