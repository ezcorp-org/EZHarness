import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("lessons-distiller registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "lessons-distiller");
  expect(manifest).toMatchObject({ name: "lessons-distiller", schemaVersion: 4 });
});
