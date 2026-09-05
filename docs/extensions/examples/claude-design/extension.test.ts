import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("claude-design registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "claude-design");
  expect(manifest).toMatchObject({ name: "claude-design", schemaVersion: 4 });
});
