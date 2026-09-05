import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("project-analyzer registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "project-analyzer");
  expect(manifest).toMatchObject({ name: "project-analyzer", schemaVersion: 4 });
});
