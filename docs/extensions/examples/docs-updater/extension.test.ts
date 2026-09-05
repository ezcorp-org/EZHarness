import { test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("docs-updater registers its actual v4 entrypoint", async () => {
  await verifyExtensionEntrypoint(() => import("./extension"), "docs-updater");
});
