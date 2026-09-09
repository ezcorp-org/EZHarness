import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("research-agent registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "research-agent");
  expect(manifest).toMatchObject({ name: "research-agent", schemaVersion: 4 });
});
