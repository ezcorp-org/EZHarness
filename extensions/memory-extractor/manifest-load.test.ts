import { expect, test } from "bun:test";
import { defineRuntimeManifest } from "@ezcorp/sdk/v4";
import memory from "./ezcorp.config";
import lessons from "../lessons-distiller/ezcorp.config";

test("memory and lessons metadata satisfy the v4 contract", () => {
  expect(() => defineRuntimeManifest(memory)).not.toThrow();
  expect(() => defineRuntimeManifest(lessons)).not.toThrow();
});

test("the memory settings retain their stored snake_case keys", () => {
  expect(memory.settings.compaction_interval_hours).toBeDefined();
  expect("compactionIntervalHours" in memory.settings).toBe(false);
});
