import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("test-agent-configs registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "test-agent-configs");
  expect(manifest).toMatchObject({ name: "test-agent-configs", schemaVersion: 4 });
});
