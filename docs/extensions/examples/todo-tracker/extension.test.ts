import { test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("todo-tracker registers its actual v4 entrypoint", async () => {
  await verifyExtensionEntrypoint(() => import("./extension"), "todo-tracker");
});
