import { expect, test } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";
import memory from "./ezcorp.config";
import lessons from "../lessons-distiller/ezcorp.config";

test("memory and lessons metadata satisfy the v4 contract", () => {
  expect(() => validateManifest(memory)).not.toThrow();
  expect(() => validateManifest(lessons)).not.toThrow();
});

test("the memory settings retain their stored snake_case keys", () => {
  expect(memory.settings.compaction_interval_hours).toBeDefined();
  expect("compactionIntervalHours" in memory.settings).toBe(false);
});
