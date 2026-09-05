import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("price-chart registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "price-chart");
  expect(manifest).toMatchObject({ name: "price-chart", schemaVersion: 4 });
});
