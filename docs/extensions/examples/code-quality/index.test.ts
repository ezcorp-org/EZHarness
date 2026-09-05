import { beforeEach, expect, spyOn, test } from "bun:test";
import { getChannel, toolError, toolResult } from "@ezcorp/sdk/runtime";
import { tools, _internals, start } from "./index";

beforeEach(() => { spyOn(getChannel(), "request").mockResolvedValue(toolResult("// TODO repair\n")); });

test("analyzes delegated file content and reports issues", async () => {
  const result = await tools.analyzeFile!({ filePath: "src/app.ts" });
  const report = JSON.parse(result.content[0]!.text!);
  expect(report.issueCount).toBe(1);
  expect(report.issues[0].rule).toBe("no-warning-comments");
  expect(getChannel().request).toHaveBeenCalledWith("ezcorp/invoke", { tool: "project-analyzer.readFile", arguments: { path: "src/app.ts" } }, undefined);
});

test("filters directory results and retains delegation errors", async () => {
  spyOn(getChannel(), "request").mockResolvedValue(toolResult("src/a.ts\nsrc/b.js\nsrc/c.ts"));
  const result = await tools.analyzeDirectory!({ dirPath: "src", extensions: "ts" });
  expect(JSON.parse(result.content[0]!.text!).filesAnalyzed).toBe(2);
  spyOn(getChannel(), "request").mockRejectedValue(new Error("Denied"));
  expect((await tools.analyzeFile!({ filePath: "private" })).isError).toBe(true);
  expect((await tools.analyzeDirectory!({ dirPath: "private" })).isError).toBe(true);
});

test("covers length, depth, and clean-content rules", () => {
  const issues = _internals.analyzeContent("long".repeat(40) + "\n                nested\n" + "line\n".repeat(301), "app.ts");
  expect(issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining(["max-line-length", "max-depth", "max-file-length"]));
  expect(_internals.analyzeContent("const value = 1;", "app.ts")).toEqual([]);
});

test("registers the tool dispatcher without a custom transport", () => {
  const registration = spyOn(getChannel(), "onRequest");
  start();
  expect(registration).toHaveBeenCalledWith("tools/call", expect.any(Function));
});

for (const [name, delegatedTool, input] of [
  ["analyzeFile", "project-analyzer.readFile", { filePath: "private" }],
  ["analyzeDirectory", "project-analyzer.listFiles", { dirPath: "private" }],
] as const) {
  test(`${name} preserves the delegated error and does not retry`, async () => {
    const denied = toolError(`${delegatedTool} denied`);
    const request = spyOn(getChannel(), "request").mockReset().mockResolvedValueOnce(denied);
    expect(await tools[name]!(input)).toEqual(denied);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("ezcorp/invoke", { tool: delegatedTool, arguments: { path: "private" } }, undefined);
    request.mockReset().mockRejectedValueOnce(new Error("Transport denied"));
    expect(await tools[name]!(input)).toEqual(toolError("Transport denied"));
    expect(request).toHaveBeenCalledTimes(1);
  });
}
