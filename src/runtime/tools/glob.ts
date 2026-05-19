import { Type } from "@mariozechner/pi-ai";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";

export function createGlobTool(projectPath: string): BuiltinToolDef {
  return {
    name: "glob",
    label: "glob",
    description: "Find files matching a glob pattern within the project directory.",
    category: "read",
    cardType: "search-results",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.svelte')" },
        path: { type: "string", description: "Relative path to search in (default: project root)", default: "." },
        maxResults: { type: "number", description: "Maximum files to return (default: 200)", default: 200 },
      },
      required: ["pattern"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const searchPath = validatePath(projectPath, params.path || ".");
        const maxResults = params.maxResults || 200;
        const glob = new Bun.Glob(params.pattern);

        const files: string[] = [];
        let truncated = false;

        for await (const file of glob.scan({ cwd: searchPath, dot: false })) {
          if (files.length >= maxResults) {
            truncated = true;
            break;
          }
          files.push(file);
        }

        if (files.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No files found matching pattern." }],
            details: { fileCount: 0, truncated: false },
          };
        }

        files.sort();
        let text = files.join("\n");
        if (truncated) {
          text += `\n[truncated at ${maxResults} results]`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: { fileCount: files.length, truncated },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: { isError: true, fileCount: 0, truncated: false },
        };
      }
    },
  };
}
