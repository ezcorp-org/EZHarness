import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("substack-engagement registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "substack-engagement");
  expect(manifest).toMatchObject({ name: "substack-engagement", schemaVersion: 4 });
});
