import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("scratchpad registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "scratchpad");
  expect(manifest).toMatchObject({ name: "scratchpad", schemaVersion: 4 });
});
