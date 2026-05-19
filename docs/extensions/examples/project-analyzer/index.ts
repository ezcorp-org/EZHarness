#!/usr/bin/env bun
// project-analyzer - Read and list project files

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";
import { fsRead } from "@ezcorp/sdk/runtime";
import { resolve, normalize } from "node:path";

// JSON-RPC server
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

const cwd = process.cwd();

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
        const res = await handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch {
        // Ignore malformed lines
      }
    }
  }
}

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
    const result = await Bun.$`ls -1 ${pattern}`.cwd(cwd).text();
    return successResponse(id, result.trim());
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

main();
