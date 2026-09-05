import { test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("code-review-delegator registers its actual v4 entrypoint", async () => {
  await verifyExtensionEntrypoint(() => import("./extension"), "code-review-delegator");
});
