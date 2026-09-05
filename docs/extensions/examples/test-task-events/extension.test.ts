import { test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("test-task-events registers its actual v4 entrypoint", async () => {
  await verifyExtensionEntrypoint(() => import("./extension"), "test-task-events");
});
