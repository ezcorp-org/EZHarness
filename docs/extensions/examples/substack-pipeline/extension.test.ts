import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("substack-pipeline registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "substack-pipeline");
  expect(manifest).toMatchObject({ name: "substack-pipeline", schemaVersion: 4 });
});
