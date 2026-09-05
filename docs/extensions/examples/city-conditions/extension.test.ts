import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("city-conditions registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "city-conditions");
  expect(manifest).toMatchObject({ name: "city-conditions", schemaVersion: 4 });
});
