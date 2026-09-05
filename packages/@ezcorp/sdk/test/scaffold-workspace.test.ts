import { expect, test } from "bun:test";
import { scaffoldWorkspace } from "../src/scaffold";
import { validateWorkspaceFiles } from "@ezcorp/extension-contract";

test("public workspace seed preserves the host echo contract and bounded source", () => {
  const { files } = scaffoldWorkspace({ name: "echo-workspace", description: "A tested workspace" });
  expect(validateWorkspaceFiles(files)).toEqual(files);
  expect(Object.keys(files).sort()).toEqual(["README.md", "extension.ts", "src/echo.test.ts", "src/echo.ts"]);
  expect(files["extension.ts"]).toContain('"name": "echo"');
  expect(files["extension.ts"]).toContain('"text": "hello"');
  expect(files["src/echo.ts"]).toContain("return { text: input.text }");
  expect(files["README.md"]).toContain("A tested workspace");
  expect(() => scaffoldWorkspace({ name: "", description: "test" })).toThrow("name is required");
  expect(() => scaffoldWorkspace({ name: "../escape", description: "test" })).toThrow("name must match");
});
