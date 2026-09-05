import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("extension-author registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "extension-author");
  expect(manifest).toMatchObject({ name: "extension-author", schemaVersion: 4 });
});
