import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("test-event-subscriber registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "test-event-subscriber");
  expect(manifest).toMatchObject({ name: "test-event-subscriber", schemaVersion: 4 });
});
