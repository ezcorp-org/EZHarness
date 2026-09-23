import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@ezcorp/sdk/v4";
import {
  SANDBOX_PROVIDER_OPERATIONS,
  canonicalJson,
  compileValueSchema,
  sandboxPresetDigest,
  sandboxProviderMethodSchemas,
  validateManifest,
} from "@ezcorp/extension-contract";
import { INCUS_CONNECTION_CONFIG_SCHEMA, parseIncusConnectionConfig } from "./config";
import { createIncusExtension, resolveHostIncusInvocationRuntime } from "./index";
import { INCUS_METHOD_GROUP, incusManifest, incusMethodName } from "./manifest";

const validConfig = {
  connectionId: "connection-1",
  serverCertificateSha256: "a".repeat(64),
  project: "ezharness",
  profile: "ezharness-feature",
  helperVersion: "0.1.0",
  guestUser: "sandbox",
};

describe("Incus extension manifest", () => {
  test("release 0.1.1 binds the reviewed image and helper in each preset digest", async () => {
    const presets = incusManifest.sandboxProviders![0]!.presets;
    const image = "57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c";
    const helper = "804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75";
    expect(incusManifest.version).toBe("0.1.1");
    for (const preset of presets) {
      expect(preset.imageDigest).toBe(image);
      expect(preset.helperDigests).toEqual([helper]);
      expect(await sandboxPresetDigest({ ...preset, imageDigest: "0".repeat(64) })).not.toBe(await sandboxPresetDigest(preset));
      expect(await sandboxPresetDigest({ ...preset, helperDigests: ["a".repeat(64)] })).not.toBe(await sandboxPresetDigest(preset));
    }
  });

  test("declares exactly the frozen 19 provider methods with canonical schemas", () => {
    expect(incusManifest.methods).toHaveLength(19);
    expect(INCUS_METHOD_GROUP.methods).toEqual({
      describe: "incus/describe",
      preflight: "incus/preflight",
      lifecycle: {
        create: "incus/lifecycle/create",
        inspect: "incus/lifecycle/inspect",
        list: "incus/lifecycle/list",
        setPower: "incus/lifecycle/setPower",
        destroy: "incus/lifecycle/destroy",
        inspectOperation: "incus/lifecycle/inspectOperation",
      },
      files: {
        stat: "incus/files/stat",
        list: "incus/files/list",
        readRange: "incus/files/readRange",
        writeAtomic: "incus/files/writeAtomic",
        remove: "incus/files/remove",
      },
      processes: {
        start: "incus/processes/start",
        inspect: "incus/processes/inspect",
        readOutput: "incus/processes/readOutput",
        cancel: "incus/processes/cancel",
      },
      endpoints: { open: "incus/endpoints/open", close: "incus/endpoints/close" },
    });
    for (const operation of SANDBOX_PROVIDER_OPERATIONS) {
      const declared = incusManifest.methods!.find((method) => method.name === incusMethodName(operation));
      expect(declared).toBeDefined();
      const canonical = sandboxProviderMethodSchemas(operation);
      expect(canonicalJson(declared!.inputSchema)).toBe(canonicalJson(canonical.inputSchema));
      expect(canonicalJson(declared!.outputSchema)).toBe(canonicalJson(canonical.outputSchema));
    }
    expect(validateManifest(incusManifest)).toEqual(incusManifest);
  });

  test("uses a closed pin-only connection schema", () => {
    const check = compileValueSchema(INCUS_CONNECTION_CONFIG_SCHEMA);
    expect(() => check(validConfig)).not.toThrow();
    expect(parseIncusConnectionConfig(validConfig)).toEqual(validConfig);
    for (const extra of [
      { url: "https://incus.internal" },
      { endpoint: "10.0.0.5:8443" },
      { privateKey: "secret" },
      { clientCertificate: "secret" },
    ]) {
      expect(() => check({ ...validConfig, ...extra })).toThrow();
    }
    expect(() => parseIncusConnectionConfig({ ...validConfig, serverCertificateSha256: "sha256:bad" })).toThrow(
      "configuration is invalid",
    );
    for (const changed of [
      { connectionId: "../other" },
      { project: "default" },
      { profile: "default" },
      { project: "--project-other" },
      { profile: "other/profile" },
    ]) {
      expect(() => parseIncusConnectionConfig({ ...validConfig, ...changed })).toThrow("configuration is invalid");
    }
    const schemaText = JSON.stringify(INCUS_CONNECTION_CONFIG_SCHEMA).toLowerCase();
    expect(schemaText).not.toContain("url");
    expect(schemaText).not.toContain("privatekey");
    expect(schemaText).not.toContain("clientcertificate");
  });

  test("does not expose provider methods as model tools", () => {
    expect(incusManifest.tools).toBeUndefined();
    expect(incusManifest.sandboxProviders?.[0]?.requiredPermissions).toEqual([]);
    expect(incusManifest.permissions.hostApi).toBeUndefined();
  });

  test("registers provider methods through the existing v4 method seam", async () => {
    let runtimeResolutions = 0;
    const extension = createIncusExtension(() => {
      runtimeResolutions++;
      return {
        config: validConfig,
        transport: { request: async () => { throw new Error("describe must not use transport"); } },
      };
    });
    const context = {
      invocation: {
        invocationId: "call",
        workerId: "worker",
        releaseId: "release",
        principalId: "owner",
        scopeId: "project",
        token: "token",
        deadline: Date.now() + 5_000,
      },
      signal: new AbortController().signal,
      call: async () => { throw new Error("describe must not use host capabilities"); },
    };
    expect(await extension.dispatch("incus/describe", { providerId: "incus" }, context)).toMatchObject({
      providerId: "incus",
      protocolMajor: 1,
    });
    expect(runtimeResolutions).toBe(0);
    expect(await extension.dispatch("incus/lifecycle/inspect", {
      providerId: "incus",
      connectionId: validConfig.connectionId,
      sandboxId: "sandbox-1",
      rpcDeadlineMs: Date.now() + 4_000,
    }, context)).toMatchObject({ ok: false });
    expect(runtimeResolutions).toBe(1);
  });

  test("requires invocation connection pins before creating host transport", () => {
    const context = {
      invocation: { metadata: {} },
      call: async () => { throw new Error("host call must not run"); },
    } as unknown as ExtensionContext;
    expect(() => resolveHostIncusInvocationRuntime(context)).toThrow(
      "Incus connection configuration is unavailable",
    );
    const configuredContext = {
      ...context,
      invocation: { ...context.invocation, metadata: { providerConfig: validConfig } },
    } as ExtensionContext;
    expect(resolveHostIncusInvocationRuntime(configuredContext).config).toEqual(validConfig);
  });
});
