import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("property-intelligence-agent registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "property-intelligence-agent");
  expect(manifest).toMatchObject({ name: "property-intelligence-agent", schemaVersion: 4 });
});
