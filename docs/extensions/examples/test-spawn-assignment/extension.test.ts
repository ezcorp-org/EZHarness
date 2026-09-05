import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("test-spawn-assignment registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "test-spawn-assignment");
  expect(manifest).toMatchObject({ name: "test-spawn-assignment", schemaVersion: 4 });
});
