import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("log-analyzer registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "log-analyzer");
  expect(manifest).toMatchObject({ name: "log-analyzer", schemaVersion: 4 });
});
