import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("seo-watcher registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "seo-watcher");
  expect(manifest).toMatchObject({ name: "seo-watcher", schemaVersion: 4 });
});
