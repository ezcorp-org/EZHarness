import { Type } from "@earendil-works/pi-ai";
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
    // biome-ignore lint/suspicious/noExplicitAny: FOLLOW-UP (highest-value remaining `any` in the tree): `params` is LLM-supplied JSON. The tool's own `parameters` JSON Schema above IS the contract, but nothing derives a TypeScript type from it, so `unknown` here would only relocate the same casts into the body. Typing these against their schemas is its own change.
    execute: async (_toolCallId, params: any) => {
      try {
        const resolved = validatePath(projectPath, params.path);
        const raw = await Bun.file(resolved).text();
        const { text, truncated, originalBytes } = truncateText(raw, getToolOutputLimit("readFile"), "readFile");
        return {
          content: [{ type: "text" as const, text }],
          details: truncated ? { truncated: true, originalBytes } : {},
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: { isError: true } };
      }
    },
  };
}
