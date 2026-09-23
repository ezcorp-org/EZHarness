import type { BuiltinToolDef } from "./types";
import { getNativeToolDefs } from "./native-tools";
import type { ShellPreviewWiring, ShellSandboxWiring } from "./shell";
import {
  getSandboxWorkspaceDispatcher,
  type SandboxWorkspaceOperation,
  type WorkspacePrincipal,
  type WorkspaceTarget as PersistedWorkspaceTarget,
} from "../workspace/target";
import { toolError } from "./types";
import {
  executeSandboxWorkspaceTool,
  isWorkspaceToolName,
  localWorkspaceTarget,
  type WorkspaceTarget as ProviderWorkspaceTarget,
} from "../workspaces/target";

export type { BuiltinToolDef, ToolCategory, PermissionMode, CardType } from "./types";
export type { ShellPreviewWiring, ShellSandboxWiring } from "./shell";
export type {
  LocalWorkspaceTarget,
  SandboxWorkspaceBackend,
  SandboxWorkspaceBinding,
  SandboxWorkspaceTarget,
  WorkspaceTarget,
  WorkspaceToolName,
} from "../workspaces/target";
export {
  isLocalFallbackDenied,
  localWorkspaceTarget,
  resolveWorkspaceTarget,
  sandboxWorkspaceTarget,
} from "../workspaces/target";

type ToolWorkspaceTarget = ProviderWorkspaceTarget | PersistedWorkspaceTarget;

/** One metadata catalog serves local and both sandbox binding generations. */
export function getBuiltinToolDefs(
  targetOrProjectPath: ToolWorkspaceTarget | string,
  preview?: ShellPreviewWiring,
  shellSandbox?: ShellSandboxWiring,
  principal?: WorkspacePrincipal,
): BuiltinToolDef[] {
  const target = typeof targetOrProjectPath === "string"
    ? localWorkspaceTarget(targetOrProjectPath)
    : targetOrProjectPath;
  if (target.kind === "local") return getNativeToolDefs(target.root, preview, shellSandbox);

  // NUL makes accidental use of any local metadata donor fail at the OS boundary.
  const definitions = getNativeToolDefs("/\0sandbox-workspace-has-no-local-root");
  return definitions.map((definition) => {
    if (!isWorkspaceToolName(definition.name)) {
      throw new Error(`Built-in tool ${definition.name} has no sandbox workspace route`);
    }
    if ("binding" in target) {
      const operation = definition.name;
      return {
        ...definition,
        execute: (toolCallId, params, signal, onUpdate) =>
          executeSandboxWorkspaceTool(target, operation, toolCallId, params, signal, onUpdate),
      };
    }
    const operation = definition.name as SandboxWorkspaceOperation;
    return {
      ...definition,
      execute: async (_toolCallId, params, signal) => {
        const dispatcher = getSandboxWorkspaceDispatcher();
        if (!dispatcher) return toolError("Sandbox workspace is unavailable");
        try {
          return await dispatcher(target, operation, params, signal, principal);
        } catch {
          return toolError("Sandbox workspace is unavailable");
        }
      },
    };
  });
}
