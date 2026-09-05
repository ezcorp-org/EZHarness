import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("task-stack registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "task-stack");
  expect(manifest).toMatchObject({ name: "task-stack", schemaVersion: 4 });
});
