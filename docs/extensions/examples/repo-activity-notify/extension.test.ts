import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("repo-activity-notify registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "repo-activity-notify");
  expect(manifest).toMatchObject({ name: "repo-activity-notify", schemaVersion: 4 });
});
