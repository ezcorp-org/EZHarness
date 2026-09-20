import type { BuiltinToolDef } from "./types";
import { createReadFileTool } from "./read-file";
import { createListFilesTool } from "./list-files";
import { createReadDirectoryTool } from "./read-directory";
import { createEditFileTool } from "./edit-file";
import { createShellTool, type ShellPreviewWiring, type ShellSandboxWiring } from "./shell";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { describeOutputCap, getToolOutputLimit } from "./output-limits";

/** Native tool catalog shared by the host and the isolated workspace helper. */
export function getNativeToolDefs(projectPath: string, preview?: ShellPreviewWiring, shellSandbox?: ShellSandboxWiring): BuiltinToolDef[] {
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
