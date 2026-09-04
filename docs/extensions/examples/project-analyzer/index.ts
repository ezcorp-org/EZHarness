#!/usr/bin/env bun
// project-analyzer - Read and list project files

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { getChannel } from "@ezcorp/sdk/runtime";
import { unwrapToolResponse } from "@ezcorp/sdk/v4";
import { fsList, fsRead } from "@ezcorp/sdk/runtime";
import { resolve, normalize } from "node:path";


const cwd = process.cwd();

// `process.stdout.write` triggers Bun's lazy lookup of `node:fs`'s
// WriteStream constructor for stdio init. Phase 3 sandbox-preload
// poisons fs module property access, so the very first stdout write
// would throw `Extension sandbox: 'fs module' blocked`. `Bun.stdout`
// is a stable Bun primitive (not gated by Phase 3 fs poisoning), so
// its writer survives the sandbox. Cached lazily so we don't pay
// the writer-creation cost on every JSON-RPC frame.

// Path validation
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

// Tool handlers
async function handleListFiles(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const pattern = (args.pattern as string) ?? "*";
  try {
    const directory = typeof args.path === "string" ? resolve(cwd, args.path) : cwd;
    if (!isUnderCwd(directory)) return errorResponse(id, -32000, "Path is outside project directory");
    const matcher = new Bun.Glob(pattern);
    const entries = await fsList(directory);
    return successResponse(id, entries.filter((entry) => matcher.match(entry.name)).map((entry) => entry.name).sort().join("\n"));
  } catch (err) {
    return errorResponse(id, -32000, `Failed to list files: ${(err as Error).message}`);
  }
}

async function handleReadFile(id: number | string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const filePath = args.path as string;
  if (!filePath) return errorResponse(id, -32602, "Missing required argument: path");
  if (!isUnderCwd(filePath)) return errorResponse(id, -32000, "Path is outside project directory");

  try {
    const resolved = resolve(cwd, normalize(filePath));
    const content = (await fsRead(resolved)) as string;
    return successResponse(id, content);
  } catch (err) {
    return errorResponse(id, -32000, `Failed to read file: ${(err as Error).message}`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    switch (toolName) {
      case "listFiles": return handleListFiles(req.id, args);
      case "readFile": return handleReadFile(req.id, args);
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

/** Exported for `index.test.ts` — driven directly with a stubbed host
 *  channel, mirroring file-refactor's `_internals` convention. */
export const _internals = { handleRequest, handleListFiles, handleReadFile, isUnderCwd, cwd };

if (import.meta.main) void main();
