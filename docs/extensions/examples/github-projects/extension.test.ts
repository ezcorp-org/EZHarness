import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("github-projects registers its actual v4 entrypoint", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "github-projects");
  expect(manifest).toMatchObject({ name: "github-projects", schemaVersion: 4 });
});
