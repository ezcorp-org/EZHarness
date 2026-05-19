#!/usr/bin/env bun
// code-review-delegator - Comprehensive code reviews via project-analyzer + code-quality

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// JSON-RPC server
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

const pendingInvokes = new Map<
  number | string,
  { resolve: (res: JsonRpcResponse) => void }
>();

let nextInvokeId = 2000;

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
        const msg = JSON.parse(line);

        if (msg.id !== undefined && !msg.method && pendingInvokes.has(msg.id)) {
          const pending = pendingInvokes.get(msg.id)!;
          pendingInvokes.delete(msg.id);
          pending.resolve(msg as JsonRpcResponse);
          continue;
        }

        const req = msg as JsonRpcRequest;
        handleRequest(req);
      } catch {
        // Ignore malformed lines
      }
    }
  }
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

  process.stdout.write(JSON.stringify(invokeReq) + "\n");

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
    process.stdout.write(JSON.stringify(errorRes) + "\n");
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
  process.stdout.write(JSON.stringify(res) + "\n");
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
    process.stdout.write(JSON.stringify(errorRes) + "\n");
    return;
  }

  const errorRes: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
  process.stdout.write(JSON.stringify(errorRes) + "\n");
}

main();
