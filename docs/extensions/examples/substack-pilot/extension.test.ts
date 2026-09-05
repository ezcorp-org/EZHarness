import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("substack-pilot registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "substack-pilot");
  expect(manifest).toMatchObject({ name: "substack-pilot", schemaVersion: 4 });
});
