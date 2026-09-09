import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("ask-user registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "ask-user");
  expect(manifest).toMatchObject({ name: "ask-user", schemaVersion: 4 });
});
