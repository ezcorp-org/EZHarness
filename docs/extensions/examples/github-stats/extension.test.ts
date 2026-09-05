import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("github-stats registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "github-stats");
  expect(manifest).toMatchObject({ name: "github-stats", schemaVersion: 4 });
});
