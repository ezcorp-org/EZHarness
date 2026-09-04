import type { ToolCallResult } from "@ezcorp/sdk";
import { createToolDispatcher, getChannel, invoke, toolError, toolResult, type ToolHandler } from "@ezcorp/sdk/runtime";

function extractText(result: ToolCallResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

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

const analyzeFile: ToolHandler = async (args) => {
  const filePath = String(args.filePath ?? "");
  try {
    const result = await invoke<ToolCallResult>("project-analyzer.readFile", { path: filePath });
    if (result.isError) return result;
    const issues = analyzeContent(extractText(result), filePath);
    return toolResult(JSON.stringify({
      filePath, issueCount: issues.length, issues,
      summary: issues.length === 0 ? "No quality issues found"
        : `Found ${issues.length} issue(s): ${issues.filter((issue) => issue.severity === "error").length} errors, ${issues.filter((issue) => issue.severity === "warning").length} warnings, ${issues.filter((issue) => issue.severity === "info").length} info`,
    }));
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
};

const analyzeDirectory: ToolHandler = async (args) => {
  const dirPath = String(args.dirPath ?? "");
  try {
    const result = await invoke<ToolCallResult>("project-analyzer.listFiles", { path: dirPath });
    if (result.isError) return result;
    const allowed = String(args.extensions || "ts,js,tsx,jsx").split(",").map((extension) => `.${extension.trim()}`);
    const files = extractText(result).split("\n").filter((file) => allowed.some((extension) => file.endsWith(extension)));
    return toolResult(JSON.stringify({ dirPath, filesAnalyzed: files.length, summary: `Found ${files.length} source file(s) to analyze` }));
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
};

export const tools: Record<string, ToolHandler> = { analyzeFile, analyzeDirectory };
export const _internals = { analyzeContent };

export function start(): void {
  getChannel();
  createToolDispatcher(tools);
}
