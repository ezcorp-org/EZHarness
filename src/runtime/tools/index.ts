import type { BuiltinToolDef } from "./types";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";
import { createReadDirectoryTool } from "./read-directory";
import { createEditFileTool } from "./edit-file";
import { createShellTool } from "./shell";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { describeOutputCap, getToolOutputLimit } from "./output-limits";

export type { BuiltinToolDef, ToolCategory, PermissionMode, CardType } from "./types";

/**
 * Get all built-in tool definitions with full metadata (category, cardType,
 * and the per-tool output cap). The cap is set from a single source of truth
 * in output-limits.ts and appended to every tool's description so both the
 * LLM and any UI listing tools can see it.
 */
export function getBuiltinToolDefs(projectPath: string): BuiltinToolDef[] {
  const defs: BuiltinToolDef[] = [
    createReadFileTool(projectPath),
    createListFilesTool(projectPath),
    createReadDirectoryTool(projectPath),
    createEditFileTool(projectPath),
    createShellTool(projectPath),
    createGrepTool(projectPath),
    createGlobTool(projectPath),
  ];
  for (const def of defs) {
    def.maxOutputBytes = getToolOutputLimit(def.name);
    def.description = `${def.description} ${describeOutputCap(def.name)}`;
  }
  return defs;
}
