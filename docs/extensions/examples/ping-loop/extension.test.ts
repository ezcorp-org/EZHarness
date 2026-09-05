import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("ping-loop registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "ping-loop");
  expect(manifest).toMatchObject({ name: "ping-loop", schemaVersion: 4 });
});
