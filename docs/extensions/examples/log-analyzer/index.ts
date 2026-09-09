#!/usr/bin/env bun
// log-analyzer - Search and filter log files

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { getChannel } from "@ezcorp/sdk/runtime";
import { unwrapToolResponse } from "@ezcorp/sdk/v4";
import { fsRead } from "@ezcorp/sdk/runtime";
import { resolve, normalize } from "node:path";

const cwd = process.cwd();

// `process.stdout.write` triggers Bun's lazy lookup of `node:fs`'s
// WriteStream constructor for stdio init. Phase 3 sandbox-preload
// poisons fs module property access, so the very first stdout write
// would throw `Extension sandbox: 'fs module' blocked`. `Bun.stdout`
// is a stable Bun primitive (not gated by Phase 3 fs poisoning), so
// its writer survives the sandbox. Cached lazily so we don't pay
// the writer-creation cost on every JSON-RPC frame.

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
    const content = (await fsRead(resolved)) as string;
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
export const _internals = { handleRequest, handleSearchLogs, isUnderCwd, cwd };

if (import.meta.main) void main();
