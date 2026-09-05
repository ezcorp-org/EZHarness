import { expect, test } from "bun:test";
import { join } from "node:path";
import { generateSourceLock } from "../../scripts/regenerate-manifest-lock";
import { getProjectRoot } from "../extensions/project-root";

test("first-party source inventory is deterministic and covers all 50 candidates without config execution", async () => {
  const first = await generateSourceLock(getProjectRoot());
  const second = await generateSourceLock(getProjectRoot());
  expect(Object.keys(first.sources)).toHaveLength(50);
  expect(second).toEqual(first);
  expect(first.schemaVersion).toBe(4);
});

test("checked-in lock matches every source snapshot, not just executable metadata", async () => {
  const generated = await generateSourceLock(getProjectRoot());
  const checkedIn = await Bun.file(join(getProjectRoot(), "manifest.lock.json")).json();
  expect(checkedIn).toEqual(generated);
});
