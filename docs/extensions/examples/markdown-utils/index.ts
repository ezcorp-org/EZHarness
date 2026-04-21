#!/usr/bin/env bun
// markdown-utils - Markdown formatting tools (persistent process)

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// JSON-RPC server
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

async function main() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch {
        // Ignore malformed lines
      }
    }
  }
}

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

main();
