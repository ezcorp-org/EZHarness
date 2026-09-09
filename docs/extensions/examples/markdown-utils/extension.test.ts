import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("markdown-utils registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "markdown-utils");
  expect(manifest).toMatchObject({ name: "markdown-utils", schemaVersion: 4 });
});
