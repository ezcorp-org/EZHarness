import { Type } from "@earendil-works/pi-ai";
import { readdir } from "node:fs/promises";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";

export function createListFilesTool(projectPath: string): BuiltinToolDef {
  return {
    name: "listFiles",
    label: "listFiles",
    description: "List files and directories at a relative path in the project. Optionally filter by glob pattern.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to list (default: project root)", default: "." },
        pattern: { type: "string", description: "Optional glob pattern to filter results (e.g. '*.ts')" },
      },
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const dir = validatePath(projectPath, params.path || ".");
        const entries = await readdir(dir, { withFileTypes: true });
        let items = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
        if (params.pattern) {
          const glob = new Bun.Glob(params.pattern);
          items = items.filter(name => glob.match(name.replace(/\/$/, "")));
        }
        return { content: [{ type: "text" as const, text: items.join("\n") || "(empty directory)" }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
