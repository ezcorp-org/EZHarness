import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("auto-note registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "auto-note");
  expect(manifest).toMatchObject({ name: "auto-note", schemaVersion: 4 });
});
