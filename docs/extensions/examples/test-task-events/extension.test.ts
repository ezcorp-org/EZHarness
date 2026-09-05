import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("test-task-events registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "test-task-events");
  expect(manifest).toMatchObject({ name: "test-task-events", schemaVersion: 4 });
});
