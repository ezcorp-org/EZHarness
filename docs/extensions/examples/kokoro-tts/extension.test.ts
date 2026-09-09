import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("kokoro-tts registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "kokoro-tts");
  expect(manifest).toMatchObject({ name: "kokoro-tts", schemaVersion: 4 });
});
