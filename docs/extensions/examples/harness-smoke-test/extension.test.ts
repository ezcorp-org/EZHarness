import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("harness-smoke-test registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "harness-smoke-test");
  expect(manifest).toMatchObject({ name: "harness-smoke-test", schemaVersion: 4 });
});
