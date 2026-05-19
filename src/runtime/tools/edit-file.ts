import { Type } from "@mariozechner/pi-ai";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath } from "./validate";
import type { BuiltinToolDef } from "./types";

export function createEditFileTool(projectPath: string): BuiltinToolDef {
  return {
    name: "editFile",
    label: "editFile",
    description:
      "Edit or create a file. To create/overwrite, provide path and new_string. To search-and-replace, also provide old_string (exact match required). To replace a line range, provide lineRange with startLine and endLine. Use readFile first to see current content.",
    category: "write",
    cardType: "diff",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from the project root" },
        new_string: { type: "string", description: "Replacement text or full file content for creation" },
        old_string: { type: "string", description: "Exact text to find and replace. Omit to create/overwrite the file." },
        replace_all: { type: "boolean", description: "Replace all occurrences (default: false)", default: false },
        lineRange: {
          type: "object",
          description: "Replace a specific line range (1-indexed, inclusive) with new_string. Alternative to old_string.",
          properties: {
            startLine: { type: "number", description: "Start line (1-indexed, inclusive)" },
            endLine: { type: "number", description: "End line (1-indexed, inclusive)" },
          },
          required: ["startLine", "endLine"],
        },
      },
      required: ["path", "new_string"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const resolved = validatePath(projectPath, params.path);
        const oldStr: string | undefined = params.old_string;
        const lineRange: { startLine: number; endLine: number } | undefined = params.lineRange;

        if (oldStr !== undefined && oldStr === "") {
          return { content: [{ type: "text" as const, text: "Error: old_string is empty. Omit old_string to create/overwrite the file." }], details: { isError: true } };
        }

        // Line range mode
        if (lineRange) {
          const file = Bun.file(resolved);
          if (!(await file.exists())) {
            return { content: [{ type: "text" as const, text: "Error: file not found. Use readFile to verify the path, or omit lineRange to create a new file." }], details: { isError: true } };
          }

          const oldContent = await file.text();
          const lines = oldContent.split("\n");
          const { startLine, endLine } = lineRange;

          if (startLine < 1 || endLine < startLine || startLine > lines.length) {
            return { content: [{ type: "text" as const, text: `Error: invalid line range ${startLine}-${endLine}. File has ${lines.length} lines.` }], details: { isError: true } };
          }

          const clampedEnd = Math.min(endLine, lines.length);
          const before = lines.slice(0, startLine - 1);
          const after = lines.slice(clampedEnd);
          const newLines = params.new_string === "" ? [] : params.new_string.split("\n");
          const newContent = [...before, ...newLines, ...after].join("\n");
          await Bun.write(resolved, newContent);

          const snippet = newContent.split("\n")
            .slice(Math.max(0, startLine - 2), startLine - 1 + newLines.length + 1)
            .map((l: string, i: number) => `${Math.max(1, startLine - 1) + i}: ${l}`)
            .join("\n");

          return {
            content: [{ type: "text" as const, text: `Replaced lines ${startLine}-${clampedEnd} in ${params.path}\n${snippet}` }],
            details: { oldContent, newContent },
          };
        }

        // Create/overwrite mode
        if (oldStr === undefined) {
          let oldContent: string | undefined;
          try {
            oldContent = await Bun.file(resolved).text();
          } catch {
            // File doesn't exist yet
          }

          await mkdir(dirname(resolved), { recursive: true });
          await Bun.write(resolved, params.new_string);
          const lines = params.new_string.split("\n");
          const preview = lines.slice(0, 4).map((l: string, i: number) => `${i + 1}: ${l}`).join("\n");
          return {
            content: [{ type: "text" as const, text: `Created/overwrote ${params.path} (${lines.length} lines)\n${preview}` }],
            details: { oldContent: oldContent ?? null, newContent: params.new_string },
          };
        }

        // Search-and-replace mode
        const file = Bun.file(resolved);
        if (!(await file.exists())) {
          return { content: [{ type: "text" as const, text: "Error: file not found. Use readFile to verify the path, or omit old_string to create a new file." }], details: { isError: true } };
        }

        const oldContent = await file.text();
        const count = oldContent.split(oldStr).length - 1;

        if (count === 0) {
          return { content: [{ type: "text" as const, text: "Error: old_string not found in file. Match the text exactly (including whitespace). Use readFile to check current content." }], details: { isError: true } };
        }

        if (count > 1 && !params.replace_all) {
          return { content: [{ type: "text" as const, text: `Error: old_string found ${count} times. Set replace_all: true to replace all, or provide more context to make old_string unique.` }], details: { isError: true } };
        }

        const newContent = params.replace_all ? oldContent.replaceAll(oldStr, params.new_string) : oldContent.replace(oldStr, params.new_string);
        await Bun.write(resolved, newContent);

        // Build snippet around first replacement
        const newLines = newContent.split("\n");
        const replaceStart = newContent.indexOf(params.new_string);
        const lineNum = newContent.slice(0, replaceStart === -1 ? 0 : replaceStart).split("\n").length;
        const start = Math.max(0, lineNum - 2);
        const end = Math.min(newLines.length, lineNum + 3);
        const snippet = newLines.slice(start, end).map((l: string, i: number) => `${start + i + 1}: ${l}`).join("\n");
        const msg = params.replace_all ? `Replaced ${count} occurrences in ${params.path}` : `Replaced in ${params.path}`;
        return {
          content: [{ type: "text" as const, text: `${msg}\n${snippet}` }],
          details: { oldContent, newContent },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
