import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("todo-tracker registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "todo-tracker");
  expect(manifest).toMatchObject({ name: "todo-tracker", schemaVersion: 4 });
});
