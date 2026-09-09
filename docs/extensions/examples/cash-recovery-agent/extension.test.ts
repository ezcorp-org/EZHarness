import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("cash-recovery-agent registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "cash-recovery-agent");
  expect(manifest).toMatchObject({ name: "cash-recovery-agent", schemaVersion: 4 });
});
