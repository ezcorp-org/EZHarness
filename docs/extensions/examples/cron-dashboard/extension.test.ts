import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("cron-dashboard registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "cron-dashboard");
  expect(manifest).toMatchObject({ name: "cron-dashboard", schemaVersion: 4 });
});
