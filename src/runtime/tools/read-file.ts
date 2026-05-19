import { Type } from "@mariozechner/pi-ai";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";
import { getToolOutputLimit, truncateText } from "./output-limits";

export function createReadFileTool(projectPath: string): BuiltinToolDef {
  return {
    name: "readFile",
    label: "readFile",
    description: "Read the contents of a file in the project. Provide a path relative to the project root.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from the project root" },
      },
      required: ["path"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const resolved = validatePath(projectPath, params.path);
        const raw = await Bun.file(resolved).text();
        const { text, truncated, originalBytes } = truncateText(raw, getToolOutputLimit("readFile"), "readFile");
        return {
          content: [{ type: "text" as const, text }],
          details: truncated ? { truncated: true, originalBytes } : {},
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
