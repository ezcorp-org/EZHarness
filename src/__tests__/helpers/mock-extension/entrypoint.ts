/**
 * Mock extension subprocess for testing.
 * Reads JSON-RPC requests from stdin (newline-delimited), writes responses to stdout.
 */

import type { JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "../../../extensions/types";

const decoder = new TextDecoder();
let buffer = "";

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
        process.stdout.write(JSON.stringify(response) + "\n");
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
