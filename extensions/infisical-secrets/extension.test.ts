import { expect, test } from "bun:test";
import { verifyExtensionEntrypoint } from "@ezcorp/sdk/test";

test("Infisical entrypoint serves its protected credential provider", async () => {
  const manifest = await verifyExtensionEntrypoint(() => import("./extension"), "infisical-secrets");
  expect(manifest.permissions.hostApi?.routes).toHaveLength(1);
});
