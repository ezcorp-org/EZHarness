import { describe, expect, test } from "bun:test";
import { validateManifest } from "@ezcorp/extension-contract";
import { INFISICAL_CONNECTION_CONFIG_SCHEMA } from "./config";
import { INFISICAL_HOST_TRANSPORT_PATH } from "./host-transport";
import { infisicalManifest } from "./manifest";

describe("Infisical extension manifest", () => {
  test("is a valid v4 extension with only the protected host route", () => {
    expect(validateManifest(infisicalManifest)).toEqual(infisicalManifest);
    expect(infisicalManifest.tools).toBeUndefined();
    expect(infisicalManifest.methods).toBeUndefined();
    expect(infisicalManifest.permissions).toEqual({
      hostApi: {
        routes: [{ method: "POST", path: INFISICAL_HOST_TRANSPORT_PATH }],
        events: false,
      },
    });
  });

  test("publishes a closed authoring schema without bootstrap-secret fields", () => {
    expect(INFISICAL_CONNECTION_CONFIG_SCHEMA.additionalProperties).toBe(false);
    const serialized = JSON.stringify({ manifest: infisicalManifest, schema: INFISICAL_CONNECTION_CONFIG_SCHEMA });
    expect(serialized).not.toContain("clientSecret");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).toContain("machineIdentityAuthReference");
  });
});
