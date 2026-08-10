#!/usr/bin/env bun
// code-review-delegator - Comprehensive code reviews via project-analyzer + code-quality

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

const decoder = new TextDecoder();

const pendingInvokes = new Map<
  number | string,
  { resolve: (res: JsonRpcResponse) => void }
>();

let nextInvokeId = 2000;

// `process.stdout.write` triggers Bun's lazy lookup of `node:fs`'s
// WriteStream constructor for stdio init. Phase 3 sandbox-preload
// poisons fs module property access, so the very first stdout write
// would throw `Extension sandbox: 'fs module' blocked`. `Bun.stdout`
// is a stable Bun primitive (not gated by Phase 3 fs poisoning), so
// its writer survives the sandbox. Cached lazily so we don't pay
// the writer-creation cost on every JSON-RPC frame.
let stdoutWriter: ReturnType<typeof Bun.stdout.writer> | null = null;
function writeStdout(s: string): void {
  if (!stdoutWriter) stdoutWriter = Bun.stdout.writer();
  stdoutWriter.write(s);
  void stdoutWriter.flush();
}

// Cross-extension invocation helper
function invoke(tool: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
  const invokeId = nextInvokeId++;
  const invokeReq: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: invokeId,
    method: "ezcorp/invoke",
    params: { tool, arguments: args },
  };

  writeStdout(JSON.stringify(invokeReq) + "\n");

  return new Promise<JsonRpcResponse>((resolve) => {
    pendingInvokes.set(invokeId, { resolve });
  });
}

function extractText(res: JsonRpcResponse): string {
  const result = res.result as { content: Array<{ type: string; text: string }> };
  return result?.content?.[0]?.text ?? "";
}

// Review orchestration
async function reviewFile(req: JsonRpcRequest, filePath: string): Promise<void> {
  // Step 1: Read file content via project-analyzer
  const readRes = await invoke("project-analyzer.readFile", { path: filePath });
  if (readRes.error) {
    const errorRes: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, error: readRes.error };
    writeStdout(JSON.stringify(errorRes) + "\n");
    return;
  }

  const fileContent = extractText(readRes);

  // Step 2: Analyze quality via code-quality
  const qualityRes = await invoke("code-quality.analyzeFile", { filePath });
  const qualityText = qualityRes.error ? "Analysis unavailable" : extractText(qualityRes);

  // Step 3: Combine into comprehensive review
  const lines = fileContent.split("\n").length;
  const review = {
    filePath,
    summary: { lines, sizeBytes: fileContent.length },
    qualityAnalysis: qualityText,
    recommendations: buildRecommendations(fileContent, qualityText),
  };

  const res: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      content: [{ type: "text", text: JSON.stringify(review) }],
      isError: false,
    },
  };
  writeStdout(JSON.stringify(res) + "\n");
}

function buildRecommendations(content: string, qualityText: string): string[] {
  const recommendations: string[] = [];
  if (content.split("\n").length > 300) recommendations.push("Consider splitting this file into smaller modules");
  if (/TODO|FIXME/i.test(content)) recommendations.push("Address outstanding TODO/FIXME comments");
  if (qualityText !== "Analysis unavailable") recommendations.push("Review quality issues listed above");
  return recommendations;
}

// Tool dispatch
function handleRequest(req: JsonRpcRequest): void {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "reviewFile") {
      reviewFile(req, String(args.filePath ?? ""));
      return;
    }

    const errorRes: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
    writeStdout(JSON.stringify(errorRes) + "\n");
    return;
  }

  const errorRes: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
  writeStdout(JSON.stringify(errorRes) + "\n");
}

/** Route one decoded stdin line: a JSON-RPC response to a pending
 *  `ezcorp/invoke` resolves the waiting promise; anything else dispatches
 *  as an inbound request. Extracted out of `main()`'s loop so tests can
 *  drive the invoke round-trip directly, without a real stdin stream. */
function handleLine(line: string): void {
  try {
    const msg = JSON.parse(line);

    if (msg.id !== undefined && !msg.method && pendingInvokes.has(msg.id)) {
      const pending = pendingInvokes.get(msg.id)!;
      pendingInvokes.delete(msg.id);
      pending.resolve(msg as JsonRpcResponse);
      return;
    }

    handleRequest(msg as JsonRpcRequest);
  } catch {
    // Ignore malformed lines
  }
}

// --- Production wiring ---
//
// The stdin reader is grabbed INSIDE `main()`, gated on `import.meta.main`:
// at module scope, opening it eagerly (and calling `main()` unconditionally)
// would lock stdin's reader the moment anything imported this file, hanging
// `index.test.ts` on a read that never resolves. Same shape as file-refactor
// / todo-tracker.
export async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      handleLine(line);
    }
  }
}

/** Exported for `index.test.ts`, mirroring file-refactor's `_internals`
 *  convention. `pendingInvokes` lets a test resolve an outbound
 *  `ezcorp/invoke` call directly, without round-tripping through a real
 *  stdin stream. */
export const _internals = {
  handleRequest,
  reviewFile,
  handleLine,
  invoke,
  pendingInvokes,
  buildRecommendations,
};

if (import.meta.main) void main();
