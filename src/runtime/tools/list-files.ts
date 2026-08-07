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
    // biome-ignore lint/suspicious/noExplicitAny: FOLLOW-UP (highest-value remaining `any` in the tree): `params` is LLM-supplied JSON. The tool's own `parameters` JSON Schema above IS the contract, but nothing derives a TypeScript type from it, so `unknown` here would only relocate the same casts into the body. Typing these against their schemas is its own change.
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
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: { isError: true } };
      }
    },
  };
}
