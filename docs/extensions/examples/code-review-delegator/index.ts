import type { ToolCallResult } from "@ezcorp/sdk";
import { createToolDispatcher, getChannel, invoke, toolError, toolResult, type ToolHandler } from "@ezcorp/sdk/runtime";

function extractText(result: ToolCallResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function buildRecommendations(content: string, qualityText: string): string[] {
  const recommendations: string[] = [];
  if (content.split("\n").length > 300) recommendations.push("Consider splitting this file into smaller modules");
  if (/TODO|FIXME/i.test(content)) recommendations.push("Address outstanding TODO/FIXME comments");
  if (qualityText !== "Analysis unavailable") recommendations.push("Review quality issues listed above");
  return recommendations;
}

const reviewFile: ToolHandler = async (args) => {
  const filePath = String(args.filePath ?? "");
  try {
    const readResult = await invoke<ToolCallResult>("project-analyzer.readFile", { path: filePath });
    if (readResult.isError) return readResult;
    const content = extractText(readResult);
    let qualityText = "Analysis unavailable";
    try {
      const qualityResult = await invoke<ToolCallResult>("code-quality.analyzeFile", { filePath });
      if (!qualityResult.isError) qualityText = extractText(qualityResult);
    } catch {}
    return toolResult(JSON.stringify({
      filePath,
      summary: { lines: content.split("\n").length, sizeBytes: content.length },
      qualityAnalysis: qualityText,
      recommendations: buildRecommendations(content, qualityText),
    }));
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
};

export const tools: Record<string, ToolHandler> = { reviewFile };
export const _internals = { buildRecommendations };

export function start(): void {
  getChannel();
  createToolDispatcher(tools);
}
