import { test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("cron-dashboard registers its actual v4 entrypoint", async () => {
  await verifyExtensionEntrypoint(() => import("./extension"), "cron-dashboard");
});
