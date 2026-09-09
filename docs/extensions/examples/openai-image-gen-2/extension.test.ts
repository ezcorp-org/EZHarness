import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("openai-image-gen-2 registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "openai-image-gen-2");
  expect(manifest).toMatchObject({ name: "openai-image-gen-2", schemaVersion: 4 });
});
