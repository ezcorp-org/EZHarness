import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("sample-loop registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "sample-loop");
  expect(manifest).toMatchObject({ name: "sample-loop", schemaVersion: 4 });
});
