#!/usr/bin/env bun
// markdown-utils - Markdown formatting tools (persistent process)

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { getChannel } from "@ezcorp/sdk/runtime";
import { unwrapToolResponse } from "@ezcorp/sdk/v4";


// `process.stdout.write` triggers Bun's lazy lookup of `node:fs`'s
// WriteStream constructor for stdio init. Phase 3 sandbox-preload
// poisons fs module property access, so the very first stdout write
// would throw `Extension sandbox: 'fs module' blocked`. `Bun.stdout`
// is a stable Bun primitive (not gated by Phase 3 fs poisoning), so
// its writer survives the sandbox. Cached lazily so we don't pay
// the writer-creation cost on every JSON-RPC frame.

function errorResponse(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function successResponse(id: number | string, text: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
}

// Tool handlers
function formatTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );

  const headerRow = "| " + headers.map((h, i) => h.padEnd(colWidths[i] ?? 0)).join(" | ") + " |";
  const separator = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataRows = rows.map(
    (row) => "| " + headers.map((_, i) => (row[i] ?? "").padEnd(colWidths[i] ?? 0)).join(" | ") + " |"
  );

  return [headerRow, separator, ...dataRows].join("\n");
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    const hashes = match?.[1];
    const text = match?.[2];
    if (hashes !== undefined && text !== undefined) {
      headings.push({ level: hashes.length, text: text.trim(), line: i + 1 });
    }
  }

  return headings;
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    switch (toolName) {
      case "format-table": {
        const headers = args.headers as string[];
        const rows = args.rows as string[][];
        if (!headers || !rows) return errorResponse(req.id, -32602, "Missing headers or rows");
        return successResponse(req.id, formatTable(headers, rows));
      }
      case "extract-headings": {
        const markdown = args.markdown as string;
        if (!markdown) return errorResponse(req.id, -32602, "Missing markdown argument");
        return successResponse(req.id, JSON.stringify(extractHeadings(markdown)));
      }
      default:
        return errorResponse(req.id, -32601, `Unknown tool: ${toolName}`);
    }
  }

  return errorResponse(req.id, -32601, `Unknown method: ${req.method}`);
}

// --- Production wiring ---
//
// The stdin reader is grabbed INSIDE `main()`, gated on `import.meta.main`:
// at module scope, opening it eagerly (and calling `main()` unconditionally)
// would lock stdin's reader the moment anything imported this file, hanging
// `index.test.ts` on a read that never resolves. Same shape as file-refactor
// / todo-tracker.
export function start(): void {
  const channel = getChannel();
  channel.onRequest("tools/call", async (params) => unwrapToolResponse(await handleRequest({
    jsonrpc: "2.0", id: 0, method: "tools/call", params: params as Record<string, unknown>,
  })));
}

export const main = start;

/** Exported for `index.test.ts`, mirroring file-refactor's `_internals`
 *  convention. */
export const _internals = { handleRequest, formatTable, extractHeadings };

if (import.meta.main) void main();
