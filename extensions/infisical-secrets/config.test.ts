import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@ezcorp/extension-contract";
import { INFISICAL_CONNECTION_CONFIG_SCHEMA, parseInfisicalConnectionConfig } from "./config";

const validConfig = () => ({
  endpoint: "https://secrets.example.test",
  projectId: "11111111-1111-4111-8111-111111111111",
  environment: "production",
  secretPath: "/ezharness/providers",
  connectionId: "infisical-production",
  machineIdentityAuthReference: "host-secret:infisical/production",
  credentials: [{
    credentialName: "OPENAI_API_KEY",
    secretName: "EZH_OPENAI_API_KEY",
    allowedExtensionIds: ["consumer-extension"],
  }],
});

describe("Infisical connection configuration", () => {
  test("accepts and freezes one exact approved scope", () => {
    const parsed = parseInfisicalConnectionConfig(validConfig());
    expect(parsed).toEqual(validConfig());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.credentials)).toBe(true);
    expect(Object.isFrozen(parsed.credentials[0]?.allowedExtensionIds)).toBe(true);
    expect(INFISICAL_CONNECTION_CONFIG_SCHEMA.additionalProperties).toBe(false);
  });

  test.each([
    ["bootstrap client ID", { clientId: "canary" }],
    ["bootstrap client secret", { clientSecret: "canary" }],
    ["access token", { accessToken: "canary" }],
    ["unknown setting", { retryCount: 99 }],
  ])("rejects %s material in the closed configuration", (_name, extra) => {
    expect(() => parseInfisicalConnectionConfig({ ...validConfig(), ...extra })).toThrow(
      "Infisical connection configuration is invalid",
    );
  });

  test.each([
    "http://secrets.example.test",
    "https://user:pass@secrets.example.test",
    "https://secrets.example.test/api",
    "https://secrets.example.test?project=other",
    "https://secrets.example.test#other",
    "https://secrets.example.test:8443",
  ])("rejects an endpoint that is not one exact default-port HTTPS origin: %s", endpoint => {
    expect(() => parseInfisicalConnectionConfig({ ...validConfig(), endpoint })).toThrow();
  });

  test.each(["relative", "/a//b", "/a/../b", "/a/./b", "/a\\b", "/"]) (
    "validates the pinned secret path: %s",
    path => {
      const call = () => parseInfisicalConnectionConfig({ ...validConfig(), secretPath: path });
      if (path === "/") expect(call().secretPath).toBe("/");
      else expect(call).toThrow();
    },
  );

  test("rejects duplicate credential mappings and duplicate consumer scopes", () => {
    const base = validConfig();
    expect(() => parseInfisicalConnectionConfig({
      ...base,
      credentials: [base.credentials[0], { ...base.credentials[0] }],
    })).toThrow();
    expect(() => parseInfisicalConnectionConfig({
      ...base,
      credentials: [{ ...base.credentials[0], allowedExtensionIds: ["consumer-extension", "consumer-extension"] }],
    })).toThrow();
  });

  const malformedScopeFields: Array<Record<string, JsonValue>> = [
    { projectId: "project-slug" },
    { environment: "Production" },
    { connectionId: "../connection" },
    { machineIdentityAuthReference: "literal-client-secret" },
    { machineIdentityAuthReference: "host-secret:infisical/../admin" },
    { machineIdentityAuthReference: "host-secret:infisical/./production" },
    { machineIdentityAuthReference: "host-secret:infisical//production" },
    { credentials: [] },
  ];
  test.each(malformedScopeFields)("rejects malformed or empty scope fields", change => {
    expect(() => parseInfisicalConnectionConfig({ ...validConfig(), ...change })).toThrow();
  });
});
