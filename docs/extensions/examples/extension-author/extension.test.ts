import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("extension-author registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "extension-author");
  expect(manifest).toMatchObject({ name: "extension-author", schemaVersion: 4 });
});

import manifest from "./ezcorp.config";
import { migrationStatus } from "./index";

test("the retired author has no host authority or authoring tools", () => {
  expect(manifest.permissions).toEqual({});
  expect(manifest.tools.map((tool) => tool.name)).toEqual(["migration_status"]);
  const result = migrationStatus();
  const status = JSON.parse(result.content[0]!.text!);
  expect(status.code).toBe("EXTENSION_AUTHOR_MOVED_TO_HOST");
  expect(status.tools).toContain("extensions_workspace");
  expect(status.tools).toContain("extensions_release");
  expect(status.approval).toContain("exact release");
});
