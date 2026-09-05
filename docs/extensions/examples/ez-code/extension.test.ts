import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("ez-code registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "ez-code");
  expect(manifest).toMatchObject({ name: "ez-code", schemaVersion: 4 });
});
