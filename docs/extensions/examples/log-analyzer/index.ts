#!/usr/bin/env bun
// log-analyzer - Search and filter log files

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { resolve, normalize } from "node:path";

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";
const cwd = process.cwd();

function isUnderCwd(filePath: string): boolean {
  const resolved = resolve(cwd, normalize(filePath));
  return resolved.startsWith(cwd + "/") || resolved === cwd;
}

function errorResponse(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function successResponse(id: number | string, text: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: false } };
}

const LEVEL_PATTERN = /\b(error|warn|info|debug)\b/i;

function extractLevel(line: string): string | null {
  const match = line.match(LEVEL_PATTERN);
  return match ? match[1]!.toLowerCase() : null;
}

const DATE_PATTERNS = [
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/,  // ISO-ish
  /(\d{4}\/\d{2}\/\d{2})/,                        // YYYY/MM/DD
  /(\d{2}\/\d{2}\/\d{4})/,                        // MM/DD/YYYY
];

function extractDate(line: string): Date | null {
  for (const pattern of DATE_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      const d = new Date(match[1]!);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

async function handleSearchLogs(
  id: number | string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const logFile = args.logFile as string;
  if (!logFile) return errorResponse(id, -32602, "Missing required argument: logFile");
  if (!isUnderCwd(logFile)) return errorResponse(id, -32000, "Path is outside project directory");

  const query = (args.query as string) ?? "";
  const level = (args.level as string) ?? "all";
  const sinceStr = args.since as string | undefined;
  const sinceDate = sinceStr ? new Date(sinceStr) : null;

  try {
    const resolved = resolve(cwd, normalize(logFile));
    const content = await Bun.file(resolved).text();
    const lines = content.split("\n");

    const matches: { lineNum: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;

      // Filter by query
      if (query && !line.toLowerCase().includes(query.toLowerCase())) continue;

      // Filter by level
      if (level !== "all") {
        const lineLevel = extractLevel(line);
        if (lineLevel !== level) continue;
      }

      // Filter by date
      if (sinceDate) {
        const lineDate = extractDate(line);
        if (lineDate && lineDate < sinceDate) continue;
      }

      matches.push({ lineNum: i + 1, text: line });
    }

    if (matches.length === 0) {
      return successResponse(id, "No matching log entries found.");
    }

    const maxShow = 100;
    const shown = matches.slice(0, maxShow);
    const output = shown.map((m) => `L${m.lineNum}: ${m.text}`).join("\n");
    const suffix =
      matches.length > maxShow
        ? `\n\n... and ${matches.length - maxShow} more matches (${matches.length} total)`
        : `\n\n${matches.length} matching entries found.`;

    return successResponse(id, output + suffix);
  } catch (err) {
    return errorResponse(id, -32000, `Failed: ${(err as Error).message}`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};
    switch (toolName) {
      case "search-logs": return handleSearchLogs(req.id, args);
      default: return errorResponse(req.id, -32601, `Unknown tool: ${toolName}`);
    }
  }
  return errorResponse(req.id, -32601, `Unknown method: ${req.method}`);
}

async function main() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch { /* ignore malformed */ }
    }
  }
}

main();
