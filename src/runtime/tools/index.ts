import type { BuiltinToolDef } from "./types";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";
import { createReadDirectoryTool } from "./read-directory";
import { createEditFileTool } from "./edit-file";
import { createShellTool, type ShellPreviewWiring, type ShellSandboxWiring } from "./shell";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { describeOutputCap, getToolOutputLimit } from "./output-limits";
import {
  getSandboxWorkspaceDispatcher,
  type SandboxWorkspaceOperation,
  type WorkspaceTarget,
} from "../workspace/target";
import { toolError } from "./types";

export type { BuiltinToolDef, ToolCategory, PermissionMode, CardType } from "./types";
export type { ShellPreviewWiring, ShellSandboxWiring } from "./shell";

/**
 * Get all built-in tool definitions with full metadata (category, cardType,
 * and the per-tool output cap). The cap is set from a single source of truth
 * in output-limits.ts and appended to every tool's description so both the
 * LLM and any UI listing tools can see it.
 *
 * `preview` (optional) threads the secure-preview spawn trigger into the
 * shell tool: when present, a recognized dev-server command is launched under
 * the conversation's preview uid. Omitted by callers without a conversation
 * context (the shell tool then behaves exactly as before).
 */
export function getBuiltinToolDefs(
  workspace: WorkspaceTarget | string,
  preview?: ShellPreviewWiring,
  shellSandbox?: ShellSandboxWiring,
): BuiltinToolDef[] {
  if (typeof workspace === "string") workspace = { kind: "local", root: workspace, revision: 0 };
  if (workspace.kind === "sandbox") return getSandboxToolDefs(workspace);
  const projectPath = workspace.root;
  const defs: BuiltinToolDef[] = [
    createReadFileTool(projectPath),
    createListFilesTool(projectPath),
    createReadDirectoryTool(projectPath),
    createEditFileTool(projectPath),
    createShellTool(projectPath, preview, shellSandbox),
    createGrepTool(projectPath),
    createGlobTool(projectPath),
  ];
  for (const def of defs) {
    def.maxOutputBytes = getToolOutputLimit(def.name);
    def.description = `${def.description} ${describeOutputCap(def.name)}`;
  }
  return defs;
}

/** Keep the existing schemas, labels, permission categories and output caps
 * identical while replacing every executable body with one host dispatcher.
 * The local bodies are metadata donors only and are never invoked here. */
function getSandboxToolDefs(workspace: Extract<WorkspaceTarget, { kind: "sandbox" }>): BuiltinToolDef[] {
  const metadata = getBuiltinToolDefs({ kind: "local", root: "/workspace-not-used", revision: workspace.revision });
  const dispatcher = getSandboxWorkspaceDispatcher();
  return metadata.map((definition) => {
    const operation = definition.name as SandboxWorkspaceOperation;
    return {
      ...definition,
      execute: async (_toolCallId, params, signal) => {
        if (!dispatcher) return toolError("Sandbox workspace is unavailable");
        try {
          return await dispatcher(workspace, operation, params, signal);
        } catch {
          return toolError("Sandbox workspace is unavailable");
        }
      },
    };
  });
}
