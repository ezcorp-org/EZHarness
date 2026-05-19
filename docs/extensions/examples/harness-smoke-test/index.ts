#!/usr/bin/env bun
// harness-smoke-test — JSON-RPC 2.0 tool server over stdio.
//
// IMPORT-SAFE: the stdin reader grab + JSON-RPC loop run ONLY when this
// file is the process entrypoint (`import.meta.main`). When merely
// imported — by `ezcorp.config.ts` for the `handleRequest` reference,
// by the host's `loadManifest` / `ezcorp ext verify` — we must NOT
// lock stdin's reader (that throws "ReadableStream is locked" on the
// next import / subprocess spawn). `Bun.stdout.writer()` is used
// instead of `process.stdout.write` because the Phase 3 sandbox-preload
// poisons `node:fs` and Bun's lazy stdio init reaches into fs
// internals on first `process.stdout.write`.

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

export function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "ping") {
      // PRETTY-print so `"ok": true` (with the post-colon space) is a
      // literal substring — that is the spec-locked smokeTest contract.
      const envelope = JSON.stringify(
        { ok: true, echo: args.message ?? "" },
        null,
        2,
      );
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: envelope }],
          isError: false,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
}

async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  const stdoutWriter = Bun.stdout.writer();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = handleRequest(req);
        stdoutWriter.write(JSON.stringify(res) + "\n");
        await stdoutWriter.flush();
      } catch {
        // Ignore malformed lines.
      }
    }
  }
}

// Only run the stdio server when launched as the entrypoint.
if (import.meta.main) {
  main();
}
