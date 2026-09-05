import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("docs-updater registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "docs-updater");
  expect(manifest).toMatchObject({ name: "docs-updater", schemaVersion: 4 });
});
