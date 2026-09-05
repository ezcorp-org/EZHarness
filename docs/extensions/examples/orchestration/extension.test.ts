import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("orchestration registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "orchestration");
  expect(manifest).toMatchObject({ name: "orchestration", schemaVersion: 4 });
});
