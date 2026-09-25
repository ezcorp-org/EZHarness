import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("Incus entrypoint serves its validated provider definition", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "incus-sandbox");
  expect(manifest.methods).toHaveLength(19);
});
