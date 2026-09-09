import { test, expect, describe } from "bun:test";
import {
  AUTO_ENABLE_ON_INSTALL,
  shouldAutoEnableOnInstall,
} from "../installer";

describe("AUTO_ENABLE_ON_INSTALL allowlist", () => {
  const listed = [
    "task-stack",
    "property-intelligence-agent",
    "substack-pipeline",
    "excel",
    "substack-pilot",
  ];

  test("contains no names: every release requires human approval", () => {
    expect([...AUTO_ENABLE_ON_INSTALL]).toEqual([]);
  });

  test.each(listed)("formerly bundled %s cannot auto-enable", (name) => {
    expect(shouldAutoEnableOnInstall(name)).toBe(false);
  });

  test.each([
    "web-search",
    "scratchpad",
    "ask-user",
    "extension-author",
    "memory-extractor",
    "unknown-extension",
    "",
  ])("shouldAutoEnableOnInstall(%s) → false (not allow-listed)", (name) => {
    expect(shouldAutoEnableOnInstall(name)).toBe(false);
  });

  test("is case-sensitive (no accidental normalization)", () => {
    expect(shouldAutoEnableOnInstall("Excel")).toBe(false);
    expect(shouldAutoEnableOnInstall("EXCEL")).toBe(false);
  });
});
