import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("file-refactor registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "file-refactor");
  expect(manifest).toMatchObject({ name: "file-refactor", schemaVersion: 4 });
});
