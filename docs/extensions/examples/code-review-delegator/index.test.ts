import { expect, spyOn, test } from "bun:test";
import { getChannel, toolError, toolResult } from "@ezcorp/sdk/runtime";
import { tools, _internals, start } from "./index";

test("combines delegated file and quality results", async () => {
  const request = spyOn(getChannel(), "request").mockResolvedValueOnce(toolResult("// TODO fix\ncode")).mockResolvedValueOnce(toolResult("One warning"));
  const result = await tools.reviewFile!({ filePath: "app.ts" });
  const report = JSON.parse(result.content[0]!.text!);
  expect(report.summary.lines).toBe(2);
  expect(report.qualityAnalysis).toBe("One warning");
  expect(report.recommendations).toContain("Address outstanding TODO/FIXME comments");
  expect(request).toHaveBeenCalledTimes(2);
});

test("returns file errors and handles unavailable optional quality analysis", async () => {
  const request = spyOn(getChannel(), "request").mockResolvedValueOnce(toolError("No access"));
  expect((await tools.reviewFile!({ filePath: "private" })).isError).toBe(true);
  request.mockResolvedValueOnce(toolResult("content")).mockRejectedValueOnce(new Error("Unavailable"));
  const result = await tools.reviewFile!({ filePath: "app.ts" });
  expect(JSON.parse(result.content[0]!.text!).qualityAnalysis).toBe("Analysis unavailable");
  request.mockRejectedValueOnce(new Error("Denied"));
  expect((await tools.reviewFile!({})).isError).toBe(true);
});

test("recommendations and registration retain their behavior", () => {
  expect(_internals.buildRecommendations("line\n".repeat(301), "Analysis unavailable")).toEqual(["Consider splitting this file into smaller modules"]);
  const registration = spyOn(getChannel(), "onRequest");
  start();
  expect(registration).toHaveBeenCalledWith("tools/call", expect.any(Function));
});
