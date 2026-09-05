import { expect, test } from "vitest";
import { extensionReviewLocation } from "$lib/api";

test("MCP staging accepts only a local release review workspace", () => {
  expect(extensionReviewLocation({ openUrl: "/extensions/author?installation=installation&workspace=draft" })).toBe("/extensions/author?installation=installation&workspace=draft");
  for (const value of [null, {}, { openUrl: 1 }, { openUrl: "https://evil.test/extensions/author?installation=id" }, { openUrl: "//evil.test/extensions/author?installation=id" }, { openUrl: "/api/extensions?installation=id" }, { openUrl: "/extensions/author" }]) expect(() => extensionReviewLocation(value)).toThrow();
});
