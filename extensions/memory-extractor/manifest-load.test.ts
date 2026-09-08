import { expect, test } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";
import memory from "./ezcorp.config";

test("memory metadata satisfies the v4 contract", () => {
  expect(() => validateManifest(memory)).not.toThrow();
});

test("the memory settings retain their stored snake_case keys", () => {
  expect(memory.settings.compaction_interval_hours).toBeDefined();
  expect("compactionIntervalHours" in memory.settings).toBe(false);
});

test("declares a stable v4 memory extractor identity without host capabilities", () => {
  expect(memory.schemaVersion).toBe(4);
  expect(memory.name).toBe("memory-extractor");
  expect(memory.permissions.filesystem).toBeUndefined();
  expect(memory.permissions.shell).toBeUndefined();
});

test("keeps compaction settings bounded and schema-visible", () => {
  expect(memory.settings.compaction_interval_hours.type).toBe("select");
  expect(memory.settings.compaction_interval_hours.default).toBe("6");
  expect(memory.settings).not.toHaveProperty("compactionIntervalHours");
});
