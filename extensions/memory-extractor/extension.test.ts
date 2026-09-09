import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("memory-extractor registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "memory-extractor");
  expect(manifest).toMatchObject({ name: "memory-extractor", schemaVersion: 4 });
});
