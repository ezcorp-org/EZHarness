import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("file-organizer registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "file-organizer");
  expect(manifest).toMatchObject({ name: "file-organizer", schemaVersion: 4 });
});
