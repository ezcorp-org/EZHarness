/**
 * Mock extension subprocess for testing.
 * Reads JSON-RPC requests from stdin (newline-delimited), writes responses to stdout.
 *
 * NOTE: uses `Bun.stdout.writer()` instead of `process.stdout.write` because
 * Phase 3's sandbox-preload poisons `node:fs` property access, and Bun's
 * lazy stdio init for `process.stdout.write` reaches into fs internals on
 * first call — surfaces as "Transport closed" in extension-runtime tests.
 * `Bun.stdout` is a stable Bun primitive that survives the fs poison.
 */

import type { JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "../../../extensions/types";

const decoder = new TextDecoder();
let buffer = "";
const stdoutWriter = Bun.stdout.writer();

async function main() {
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request: JsonRpcRequest = JSON.parse(line);
        const response = handleRequest(request);
        stdoutWriter.write(JSON.stringify(response) + "\n");
        await stdoutWriter.flush();
      } catch {
        // Skip malformed lines
      }
    }
  }
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const params = req.params as { name: string; arguments?: Record<string, unknown> };

    if (params.name === "echo") {
      const text = (params.arguments?.text as string) ?? "";
      const result: ToolCallResult = {
        content: [{ type: "text", text }],
        isError: false,
      };
      return { jsonrpc: "2.0", id: req.id, result };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown tool: ${params.name}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
}

main();
