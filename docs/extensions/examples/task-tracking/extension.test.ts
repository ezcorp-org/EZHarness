import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("task-tracking registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "task-tracking");
  expect(manifest).toMatchObject({ name: "task-tracking", schemaVersion: 4 });
});
