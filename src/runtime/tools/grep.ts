import { Type } from "@mariozechner/pi-ai";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";
import { getToolOutputLimit, truncateText } from "./output-limits";

export function createGrepTool(projectPath: string): BuiltinToolDef {
  return {
    name: "grep",
    label: "grep",
    description: "Search for a pattern in files within the project. Returns matching lines with file paths and line numbers.",
    category: "read",
    cardType: "search-results",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (basic regex)" },
        path: { type: "string", description: "Relative path to search in (default: project root)", default: "." },
        include: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
        caseSensitive: { type: "boolean", description: "Case sensitive search (default: true)", default: true },
        contextLines: { type: "number", description: "Lines of context around matches (0-5, default: 0)", default: 0 },
        maxResults: { type: "number", description: "Maximum matches to return (default: 100)", default: 100 },
      },
      required: ["pattern"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const searchPath = validatePath(projectPath, params.path || ".");
        const args: string[] = ["-rn", "--color=never"];

        if (!params.caseSensitive) {
          args.push("-i");
        }

        const contextLines = Math.min(Math.max(params.contextLines || 0, 0), 5);
        if (contextLines > 0) {
          args.push(`-C${contextLines}`);
        }

        if (params.include) {
          args.push(`--include=${params.include}`);
        }

        const maxResults = params.maxResults || 100;
        args.push(`-m${maxResults}`);

        args.push(params.pattern, searchPath);

        const proc = Bun.spawn(["grep", ...args], {
          cwd: projectPath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode === 1 || !stdout.trim()) {
          return {
            content: [{ type: "text" as const, text: "No matches found." }],
            details: { matchCount: 0, pattern: params.pattern },
          };
        }

        if (exitCode === 2) {
          return {
            content: [{ type: "text" as const, text: `Error: ${stderr || "grep error"}` }],
            details: { isError: true, matchCount: 0 },
          };
        }

        // Count matches (non-context lines starting with filename:linenum:)
        const trimmed = stdout.trim();
        const lines = trimmed.split("\n");
        const matchCount = lines.filter(l => /^.+:\d+:/.test(l)).length;

        const { text, truncated, originalBytes } = truncateText(trimmed, getToolOutputLimit("grep"), "grep");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            matchCount,
            pattern: params.pattern,
            ...(truncated ? { truncated: true, originalBytes } : {}),
          },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${e.message}` }],
          details: { isError: true, matchCount: 0 },
        };
      }
    },
  };
}
