#!/usr/bin/env bun
// code-quality - Static quality analysis via JSON-RPC

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

const pendingInvokes = new Map<
  number | string,
  { resolve: (res: JsonRpcResponse) => void }
>();
let nextInvokeId = 3000;

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

        // Check if this is a response to a pending invoke
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

// Cross-extension invocation via ezcorp/invoke reverse RPC
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

// Quality analysis logic
interface QualityIssue {
  line?: number;
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
}

function analyzeContent(content: string, _filePath: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNum = i + 1;

    // Long lines
    if (line.length > 120) {
      issues.push({ line: lineNum, rule: "max-line-length", severity: "warning", message: `Line exceeds 120 characters (${line.length})` });
    }

    // TODO/FIXME/HACK comments
    if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
      issues.push({ line: lineNum, rule: "no-warning-comments", severity: "info", message: "Contains a warning comment" });
    }

    // Deeply nested blocks (4+ levels)
    const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (leadingSpaces >= 16 && line.trim().length > 0) {
      issues.push({ line: lineNum, rule: "max-depth", severity: "warning", message: "Deeply nested code (4+ levels)" });
    }
  }

  // File-level checks
  if (lines.length > 300) {
    issues.push({ rule: "max-file-length", severity: "warning", message: `File has ${lines.length} lines — consider splitting` });
  }

  return issues;
}

// Tool handlers
async function handleAnalyzeFile(req: JsonRpcRequest, filePath: string): Promise<void> {
  // Use project-analyzer to read the file
  const readRes = await invoke("project-analyzer.readFile", { path: filePath });

  if (readRes.error) {
    const errorRes: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, error: readRes.error };
    process.stdout.write(JSON.stringify(errorRes) + "\n");
    return;
  }

  const content = extractText(readRes);
  const issues = analyzeContent(content, filePath);

  const report = {
    filePath,
    issueCount: issues.length,
    issues,
    summary: issues.length === 0
      ? "No quality issues found"
      : `Found ${issues.length} issue(s): ${issues.filter(i => i.severity === "error").length} errors, ${issues.filter(i => i.severity === "warning").length} warnings, ${issues.filter(i => i.severity === "info").length} info`,
  };

  const res: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      content: [{ type: "text", text: JSON.stringify(report) }],
      isError: false,
    },
  };
  process.stdout.write(JSON.stringify(res) + "\n");
}

async function handleAnalyzeDirectory(req: JsonRpcRequest, dirPath: string, extensions: string): Promise<void> {
  // Use project-analyzer to list files
  const listRes = await invoke("project-analyzer.listFiles", { path: dirPath });

  if (listRes.error) {
    const errorRes: JsonRpcResponse = { jsonrpc: "2.0", id: req.id, error: listRes.error };
    process.stdout.write(JSON.stringify(errorRes) + "\n");
    return;
  }

  const fileList = extractText(listRes);
  const allowedExts = (extensions || "ts,js,tsx,jsx").split(",").map(e => `.${e.trim()}`);
  const files = fileList.split("\n").filter(f => allowedExts.some(ext => f.endsWith(ext)));

  const report = {
    dirPath,
    filesAnalyzed: files.length,
    summary: `Found ${files.length} source file(s) to analyze`,
  };

  const res: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      content: [{ type: "text", text: JSON.stringify(report) }],
      isError: false,
    },
  };
  process.stdout.write(JSON.stringify(res) + "\n");
}

function handleRequest(req: JsonRpcRequest): void {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "analyzeFile") {
      handleAnalyzeFile(req, String(args.filePath ?? ""));
      return;
    }

    if (toolName === "analyzeDirectory") {
      handleAnalyzeDirectory(req, String(args.dirPath ?? ""), String(args.extensions ?? ""));
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
