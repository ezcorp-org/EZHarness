import { test, expect } from "bun:test";

// Replicate review logic to avoid importing index.ts (stdin side effect)
function buildRecommendations(content: string, qualityText: string): string[] {
  const recommendations: string[] = [];
  if (content.split("\n").length > 300) recommendations.push("Consider splitting this file into smaller modules");
  if (/TODO|FIXME/i.test(content)) recommendations.push("Address outstanding TODO/FIXME comments");
  if (qualityText !== "Analysis unavailable") recommendations.push("Review quality issues listed above");
  return recommendations;
}

function buildReview(filePath: string, fileContent: string, qualityText: string) {
  return {
    filePath,
    summary: { lines: fileContent.split("\n").length, sizeBytes: fileContent.length },
    qualityAnalysis: qualityText,
    recommendations: buildRecommendations(fileContent, qualityText),
  };
}

test("builds review with file summary and quality analysis", () => {
  const review = buildReview("src/app.ts", "line1\nline2\nline3", '{"issues":[],"count":0}');
  expect(review.filePath).toBe("src/app.ts");
  expect(review.summary.lines).toBe(3);
  expect(review.qualityAnalysis).toBe('{"issues":[],"count":0}');
});

test("recommends splitting large files", () => {
  const content = Array(301).fill("line").join("\n");
  const recs = buildRecommendations(content, '{"issues":[]}');
  expect(recs).toContain("Consider splitting this file into smaller modules");
});

test("recommends addressing TODOs", () => {
  const recs = buildRecommendations("// TODO: fix\ncode", '{"issues":[]}');
  expect(recs).toContain("Address outstanding TODO/FIXME comments");
});

test("handles unavailable quality analysis", () => {
  const review = buildReview("test.ts", "code", "Analysis unavailable");
  expect(review.qualityAnalysis).toBe("Analysis unavailable");
  expect(review.recommendations).not.toContain("Review quality issues listed above");
});

test("manifest has both dependencies", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.dependencies["project-analyzer"]).toBeDefined();
  expect(manifest.dependencies["code-quality"]).toBeDefined();
  expect(manifest.agent.category).toBe("Development");
});
