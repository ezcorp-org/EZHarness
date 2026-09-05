import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("graded-card-scanner registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "graded-card-scanner");
  expect(manifest).toMatchObject({ name: "graded-card-scanner", schemaVersion: 4 });
});
