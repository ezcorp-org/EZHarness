import { Type } from "@mariozechner/pi-ai";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";

export function createReadDirectoryTool(projectPath: string): BuiltinToolDef {
  return {
    name: "readDirectory",
    label: "readDirectory",
    description: "Show the directory tree structure of the project (up to 2 levels deep). Useful for orientation.",
    category: "read",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to show tree for (default: project root)", default: "." },
        depth: { type: "number", description: "Max depth (1-3, default 2)", default: 2 },
      },
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const dir = validatePath(projectPath, params.path || ".");
        const maxDepth = Math.min(Math.max(params.depth || 2, 1), 3);
        const lines: string[] = [];

        async function walk(current: string, prefix: string, depth: number) {
          if (depth > maxDepth) return;
          const entries = await readdir(current, { withFileTypes: true });
          const sorted = entries
            .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
          for (let i = 0; i < sorted.length; i++) {
            const entry = sorted[i]!;
            const isLast = i === sorted.length - 1;
            const connector = isLast ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ";
            const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
            lines.push(`${prefix}${connector}${name}`);
            if (entry.isDirectory()) {
              await walk(resolve(current, entry.name), prefix + (isLast ? "    " : "\u2502   "), depth + 1);
            }
          }
        }

        await walk(dir, "", 1);
        return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty directory)" }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
