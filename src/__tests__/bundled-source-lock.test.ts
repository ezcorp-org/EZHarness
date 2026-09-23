import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspaceText } from "@ezcorp/extension-contract";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { generateSourceLock } from "../../scripts/regenerate-manifest-lock";
import { getProjectRoot } from "../extensions/project-root";

test("first-party source inventory is deterministic and covers all 51 candidates without config execution", async () => {
  const first = await generateSourceLock(getProjectRoot());
  const second = await generateSourceLock(getProjectRoot());
  expect(Object.keys(first.sources)).toHaveLength(51);
  expect(first.sources["local-sandbox"]).toMatchObject({ directory: "extensions/local-sandbox" });
  expect(second).toEqual(first);
  expect(first.schemaVersion).toBe(4);
});

test("checked-in lock matches every source snapshot, not just executable metadata", async () => {
  const generated = await generateSourceLock(getProjectRoot());
  const checkedIn = await Bun.file(join(getProjectRoot(), "manifest.lock.json")).json();
  expect(checkedIn).toEqual(generated);
});

test("AI Kit frozen dependencies match its shipped source", async () => {
  const { files } = await snapshotFirstPartyExtension(getProjectRoot(), "ai-kit");
  const manifest = JSON.parse(workspaceText(files["package.json"], "package.json"));
  const lock = JSON.parse(workspaceText(files["package-lock.json"], "package-lock.json"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  expect(Object.keys(declared).length).toBeGreaterThan(0);
  expect(lock.packages[""].dependencies).toEqual(declared);
  for (const [name, version] of Object.entries(declared)) {
    expect(lock.packages[`node_modules/${name}`].version).toBe(version);
  }
});
