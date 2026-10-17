import { validateManifest, type ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { INFISICAL_HOST_TRANSPORT_PATH } from "./host-transport";

export const INFISICAL_PROVIDER_ID = "infisical";

export const infisicalManifest: ExtensionManifestV4 = validateManifest({
  schemaVersion: 4,
  name: "infisical-secrets",
  version: "0.1.0",
  description: "Infisical static-secret provider over the host-owned protected transport.",
  author: { name: "EZCorp" },
  entrypoint: "./extension.ts",
  permissions: {
    hostApi: {
      routes: [{ method: "POST", path: INFISICAL_HOST_TRANSPORT_PATH }],
      events: false,
    },
  },
});
