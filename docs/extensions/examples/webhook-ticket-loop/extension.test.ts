import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("webhook-ticket-loop registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "webhook-ticket-loop");
  expect(manifest).toMatchObject({ name: "webhook-ticket-loop", schemaVersion: 4 });
});
