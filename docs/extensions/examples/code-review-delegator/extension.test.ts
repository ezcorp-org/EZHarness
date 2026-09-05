import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("code-review-delegator registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "code-review-delegator");
  expect(manifest).toMatchObject({ name: "code-review-delegator", schemaVersion: 4 });
});
