import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("code-quality registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "code-quality");
  expect(manifest).toMatchObject({ name: "code-quality", schemaVersion: 4 });
});
