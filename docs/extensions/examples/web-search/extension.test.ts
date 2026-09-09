import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("web-search registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "web-search");
  expect(manifest).toMatchObject({ name: "web-search", schemaVersion: 4 });
});
