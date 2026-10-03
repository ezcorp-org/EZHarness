import { describe, expect, test } from "bun:test";
import { createSession, type ExtensionContext, type ProviderCredentialInput } from "@ezcorp/sdk/v4";
import { parseInfisicalConnectionConfig } from "./config";
import { createHostInfisicalTransport } from "./host-transport";
import { createHostInfisicalExtension, createInfisicalExtension } from "./index";
import { InfisicalStaticSecretProvider, type InfisicalLifetimeMetadata } from "./provider";
import {
  InfisicalProviderError,
  type InfisicalHttpRequest,
  type InfisicalHttpResponse,
  type InfisicalHttpTransport,
} from "./transport";

const canary = "infisical-secret-canary-89c31";
const projectId = "11111111-1111-4111-8111-111111111111";
const configValue = () => ({
  endpoint: "https://secrets.example.test",
  projectId,
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
const config = () => parseInfisicalConnectionConfig(configValue());
const input = (overrides: Partial<ProviderCredentialInput> = {}): ProviderCredentialInput => ({
  providerId: "infisical",
  connectionId: "infisical-production",
  name: "OPENAI_API_KEY",
  scope: { extensionId: "consumer-extension", userId: "user-a", conversationId: "conversation-a" },
  ...overrides,
});
const login = (token = "access-token", expiresIn = 120): InfisicalHttpResponse => ({
  status: 200,
  body: JSON.stringify({ accessToken: token, expiresIn, accessTokenMaxTTL: expiresIn, tokenType: "Bearer" }),
});
const secret = (overrides: Record<string, unknown> = {}): InfisicalHttpResponse => ({
  status: 200,
  body: JSON.stringify({
    secret: {
      workspace: projectId,
      environment: "production",
      secretPath: "/ezharness/providers",
      secretKey: "EZH_OPENAI_API_KEY",
      secretValue: canary,
      type: "shared",
      ...overrides,
    },
  }),
});

class QueueTransport implements InfisicalHttpTransport {
  readonly requests: InfisicalHttpRequest[] = [];
  constructor(private readonly responses: Array<InfisicalHttpResponse | Error>) {}
  async request(request: Readonly<InfisicalHttpRequest>): Promise<Readonly<InfisicalHttpResponse>> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Missing fake response");
    return response;
  }
}

describe("Infisical static-secret provider", () => {
  test("uses only the configured mapping and fixed static lookup parameters", async () => {
    const metadata: InfisicalLifetimeMetadata[] = [];
    const transport = new QueueTransport([login(), secret()]);
    const provider = new InfisicalStaticSecretProvider(config(), {
      now: () => 1_000,
      onLifetimeMetadata: value => metadata.push(value),
    });

    expect(await provider.resolve(input(), transport)).toBe(canary);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toEqual({
      method: "POST",
      endpoint: "https://secrets.example.test",
      path: "/api/v1/auth/universal-auth/login",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: { machineIdentityAuthReference: "host-secret:infisical/production" },
      redirect: "manual",
      timeoutMs: 10_000,
      maxResponseBytes: 65_536,
    });
    expect(transport.requests[1]).toEqual({
      method: "GET",
      endpoint: "https://secrets.example.test",
      path: "/api/v4/secrets/EZH_OPENAI_API_KEY",
      query: {
        projectId,
        environment: "production",
        secretPath: "/ezharness/providers",
        type: "shared",
        viewSecretValue: "true",
        expandSecretReferences: "false",
        includeImports: "false",
      },
      headers: { accept: "application/json", authorization: "Bearer access-token" },
      redirect: "manual",
      timeoutMs: 10_000,
      maxResponseBytes: 65_536,
    });
    expect(metadata).toEqual([{
      providerAuth: { kind: "infisical-access-token", issuedAtMs: 1_000, expiresAtMs: 121_000, renewal: 1 },
      brokerHandle: { authority: "host", validity: "host-managed" },
      staticCredential: { kind: "static", issuerExpiry: "not-provided", renewable: false, dynamicLease: false },
    }]);
  });

  test.each([
    ["wrong provider", input({ providerId: "other" })],
    ["wrong connection", input({ connectionId: "other" })],
    ["undeclared name", input({ name: "GITHUB_TOKEN" })],
    ["unapproved extension", input({ scope: { extensionId: "other", userId: "user-a", conversationId: null } })],
  ])("denies %s before transport", async (_name, request) => {
    const transport = new QueueTransport([]);
    const provider = new InfisicalStaticSecretProvider(config());
    await expect(provider.resolve(request, transport)).rejects.toMatchObject({
      code: request.name === "OPENAI_API_KEY" && request.scope.extensionId === "consumer-extension" ? "invalid_request" : "scope_denied",
    });
    expect(transport.requests).toHaveLength(0);
  });

  test.each([
    ["project", { workspace: "22222222-2222-4222-8222-222222222222" }],
    ["environment", { environment: "development" }],
    ["path", { secretPath: "/other" }],
    ["key", { secretKey: "OTHER" }],
    ["type", { type: "personal" }],
  ])("rejects a response from the wrong %s", async (_name, change) => {
    const provider = new InfisicalStaticSecretProvider(config());
    await expect(provider.resolve(input(), new QueueTransport([login(), secret(change)]))).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });

  test("returns null only for an approved mapping that Infisical does not contain", async () => {
    const provider = new InfisicalStaticSecretProvider(config());
    const transport = new QueueTransport([login(), { status: 404, body: JSON.stringify({ message: canary }) }]);
    expect(await provider.resolve(input(), transport)).toBeNull();
  });

  test("caches provider auth until its issuer-reported lifetime reaches the refresh window", async () => {
    let now = 1_000;
    const metadata: InfisicalLifetimeMetadata[] = [];
    const transport = new QueueTransport([login("token-1", 100), secret(), secret(), login("token-2", 100), secret()]);
    const provider = new InfisicalStaticSecretProvider(config(), { now: () => now, onLifetimeMetadata: value => metadata.push(value) });
    await provider.resolve(input(), transport);
    now = 50_000;
    await provider.resolve(input(), transport);
    now = 92_000;
    await provider.resolve(input(), transport);
    expect(transport.requests.filter(request => request.path === "/api/v1/auth/universal-auth/login")).toHaveLength(2);
    expect(metadata.map(value => value.providerAuth.renewal)).toEqual([1, 2]);
    expect(metadata[1]?.providerAuth.expiresAtMs).toBe(192_000);
  });

  test("renews authentication once after an unauthorized lookup and records the new lifetime", async () => {
    const metadata: InfisicalLifetimeMetadata[] = [];
    const transport = new QueueTransport([
      login("old-token"),
      { status: 401, body: JSON.stringify({ message: canary }) },
      login("new-token"),
      secret(),
    ]);
    const provider = new InfisicalStaticSecretProvider(config(), { now: () => 5_000, onLifetimeMetadata: value => metadata.push(value) });
    expect(await provider.resolve(input(), transport)).toBe(canary);
    expect(metadata.map(value => value.providerAuth.renewal)).toEqual([1, 2]);
    expect(transport.requests.at(-1)?.headers.authorization).toBe("Bearer new-token");
  });

  test("does not loop when the renewed authentication remains unauthorized", async () => {
    const transport = new QueueTransport([login("old"), { status: 401, body: "{}" }, login("new"), { status: 401, body: "{}" }]);
    const provider = new InfisicalStaticSecretProvider(config());
    await expect(provider.resolve(input(), transport)).rejects.toMatchObject({ code: "scope_denied" });
    expect(transport.requests).toHaveLength(4);
  });

  test("retries one safe lookup and classifies the final rate limit", async () => {
    const sleeps: number[] = [];
    const transport = new QueueTransport([
      login(),
      { status: 429, headers: { "Retry-After": "2" }, body: JSON.stringify({ message: canary }) },
      { status: 429, headers: { "retry-after": "2" }, body: JSON.stringify({ message: canary }) },
    ]);
    const provider = new InfisicalStaticSecretProvider(config(), { sleep: milliseconds => { sleeps.push(milliseconds); return Promise.resolve(); } });
    await expect(provider.resolve(input(), transport)).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 1_000 });
    expect(sleeps).toEqual([1_000]);
  });

  test("retries a transient safe lookup but not the authentication exchange", async () => {
    const lookup = new QueueTransport([login(), new Error(canary), secret()]);
    expect(await new InfisicalStaticSecretProvider(config()).resolve(input(), lookup)).toBe(canary);

    const authentication = new QueueTransport([new Error(canary), login(), secret()]);
    await expect(new InfisicalStaticSecretProvider(config()).resolve(input(), authentication)).rejects.toMatchObject({ code: "unavailable" });
    expect(authentication.requests).toHaveLength(1);
  });

  test.each([
    ["login redirect", [{ status: 302, headers: { location: `https://evil.test/${canary}` }, body: "" }], "redirect_denied"],
    ["lookup redirect", [login(), { status: 307, headers: { location: `https://evil.test/${canary}` }, body: "" }], "redirect_denied"],
    ["malformed login", [{ status: 200, body: `{"accessToken":"${canary}"` }], "invalid_response"],
    ["malformed lookup", [login(), { status: 200, body: `{"secret":"${canary}"` }], "invalid_response"],
    ["oversized login", [{ status: 200, body: "x".repeat(65_537) }], "response_too_large"],
    ["oversized lookup", [login(), { status: 200, body: "x".repeat(65_537) }], "response_too_large"],
    ["server failure", [login(), { status: 503, body: canary }, { status: 503, body: canary }], "unavailable"],
  ] as const)("classifies %s without unsafe response details", async (_name, responses, code) => {
    const provider = new InfisicalStaticSecretProvider(config());
    const error = await provider.resolve(input(), new QueueTransport([...responses])).catch(value => value as Error);
    expect(error).toBeInstanceOf(InfisicalProviderError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(canary);
  });

  test("rejects malformed login lifetime and static-secret values without inventing expiry", async () => {
    await expect(new InfisicalStaticSecretProvider(config()).resolve(input(), new QueueTransport([
      { status: 200, body: JSON.stringify({ accessToken: canary, expiresIn: 0, accessTokenMaxTTL: 0, tokenType: "Bearer" }) },
    ]))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(new InfisicalStaticSecretProvider(config()).resolve(input(), new QueueTransport([
      login(), secret({ secretValue: `${canary}\nleak` }),
    ]))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(new InfisicalStaticSecretProvider(config()).resolve(input(), new QueueTransport([
      login(`token\u0000${canary}`),
    ]))).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("never writes a secret-bearing failure to console output", async () => {
    const output: string[] = [];
    const originals = [console.log, console.warn, console.error] as const;
    console.log = (...values: unknown[]) => { output.push(values.join(" ")); };
    console.warn = (...values: unknown[]) => { output.push(values.join(" ")); };
    console.error = (...values: unknown[]) => { output.push(values.join(" ")); };
    try {
      const provider = new InfisicalStaticSecretProvider(config());
      const error = await provider.resolve(input(), new QueueTransport([
        login(),
        { status: 400, body: JSON.stringify({ message: canary }) },
      ])).catch(value => value as Error);
      expect(String(error)).not.toContain(canary);
      expect(output.join("\n")).not.toContain(canary);
    } finally {
      [console.log, console.warn, console.error] = originals;
    }
  });

  test("the host transport accepts only a bounded response envelope", async () => {
    const request: InfisicalHttpRequest = {
      method: "POST",
      endpoint: "https://secrets.example.test",
      path: "/api/v1/auth/universal-auth/login",
      headers: {},
      redirect: "manual",
      timeoutMs: 10_000,
      maxResponseBytes: 65_536,
    };
    const call = async () => ({ status: 200, body: "{}", headers: { "retry-after": "1" } });
    const transport = createHostInfisicalTransport({ call });
    expect(await transport.request(request)).toEqual({ status: 200, body: "{}", headers: { "retry-after": "1" } });
    const unavailable = createHostInfisicalTransport({ call: async () => { throw new Error(canary); } });
    await expect(unavailable.request(request)).rejects.toMatchObject({ code: "unavailable" });
    const malformed = createHostInfisicalTransport({ call: async () => ({ status: "200", body: canary }) });
    await expect(malformed.request(request)).rejects.toMatchObject({ code: "invalid_response" });
    for (const response of [null, [], { status: 200, body: "{}", headers: [] }, { status: 200, body: "{}", headers: { count: 1 } }]) {
      const invalid = createHostInfisicalTransport({ call: async () => response });
      await expect(invalid.request(request)).rejects.toMatchObject({ code: "invalid_response" });
    }
    const noHeaders = createHostInfisicalTransport({ call: async () => ({ status: 204, body: "" }) });
    expect(await noHeaders.request(request)).toEqual({ status: 204, body: "" });
  });

  test("reuses authentication for one connection and replaces it when the pins change", async () => {
    let current = config();
    const transport = new QueueTransport([
      login(), secret(), secret(), login(), secret({ secretKey: "ROTATED_KEY" }),
    ]);
    const extension = createInfisicalExtension(async () => ({ config: current, transport }));
    const context = {
      invocation: {
        invocationId: "cache-test", workerId: "worker", releaseId: "release",
        principalId: "owner", scopeId: "project", token: "token", deadline: Date.now() + 10_000,
      },
      signal: new AbortController().signal,
      call: async () => null,
    } satisfies ExtensionContext;
    expect(await extension.resolveProviderCredential!(input(), context)).toBe(canary);
    expect(await extension.resolveProviderCredential!(input(), context)).toBe(canary);
    expect(transport.requests.map(request => request.method)).toEqual(["POST", "GET", "GET"]);
    current = parseInfisicalConnectionConfig({
      ...configValue(),
      credentials: [{ ...configValue().credentials[0]!, secretName: "ROTATED_KEY" }],
    });
    expect(await extension.resolveProviderCredential!(input(), context)).toBe(canary);
    expect(transport.requests.map(request => request.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
  });

  test("bounds cached provider connections", async () => {
    let connectionId = "connection-0";
    const transport: InfisicalHttpTransport = {
      request: async request => request.method === "POST" ? login() : secret(),
    };
    const extension = createInfisicalExtension(async () => ({
      config: parseInfisicalConnectionConfig({ ...configValue(), connectionId }),
      transport,
    }));
    const context = {
      invocation: {
        invocationId: "limit-test", workerId: "worker", releaseId: "release",
        principalId: "owner", scopeId: "project", token: "token", deadline: Date.now() + 10_000,
      },
      signal: new AbortController().signal,
      call: async () => null,
    } satisfies ExtensionContext;
    for (let index = 0; index < 32; index++) {
      connectionId = `connection-${index}`;
      expect(await extension.resolveProviderCredential!(input({ connectionId }), context)).toBe(canary);
    }
    connectionId = "connection-32";
    await expect(extension.resolveProviderCredential!(input({ connectionId }), context)).rejects.toThrow(
      "Infisical provider connection limit reached",
    );
  });

  test("resolves a credential through the host backed extension", async () => {
    const calls: Array<{ name: string; args: { body: InfisicalHttpRequest } }> = [];
    const context = {
      invocation: {
        invocationId: "host-test", workerId: "worker", releaseId: "release",
        principalId: "owner", scopeId: "project", token: "token", deadline: Date.now() + 10_000,
        metadata: { providerConfig: configValue() },
      },
      signal: new AbortController().signal,
      call: async (name: string, args: { body: InfisicalHttpRequest }) => {
        calls.push({ name, args });
        return args.body.method === "POST" ? login() : secret();
      },
    } as ExtensionContext;
    const extension = createHostInfisicalExtension();
    expect(await extension.resolveProviderCredential!(input(), context)).toBe(canary);
    expect(calls.map(call => call.name)).toEqual(["ezcorp/api.request", "ezcorp/api.request"]);
    expect(calls.map(call => call.args.body.method)).toEqual(["POST", "GET"]);
  });

  test("the v4 definition exposes the provider only on the classified credential handler", async () => {
    const transport = new QueueTransport([login(), secret()]);
    const extension = createInfisicalExtension(async () => ({ config: config(), transport }));
    expect(extension.manifest.tools).toBeUndefined();
    expect(extension.manifest.methods).toBeUndefined();
    expect(extension.resolveProviderCredential).toBeFunction();
    const context = {
      invocation: {
        invocationId: "invocation-a",
        workerId: "worker-a",
        releaseId: "release-a",
        principalId: "principal-a",
        scopeId: "scope-a",
        token: "token-a",
        deadline: Date.now() + 10_000,
      },
      signal: new AbortController().signal,
      call: async () => null,
    } satisfies ExtensionContext;
    expect(await extension.resolveProviderCredential!(input(), context)).toBe(canary);
    await expect(extension.dispatch("provider/credentials.resolve", input(), context)).rejects.toThrow("Unknown extension contribution");
  });

  test("maps an approved reference into only the classified sensitive envelope", async () => {
    const transport = new QueueTransport([login(), secret()]);
    const extension = createInfisicalExtension(async () => ({ config: config(), transport }));
    const frames: Array<Record<string, unknown>> = [];
    const session = createSession(extension, frame => { frames.push(JSON.parse(frame) as Record<string, unknown>); });
    await session.receive({ jsonrpc: "2.0", id: "discover", method: "extension/discover", params: {} });
    expect(JSON.stringify(frames[0])).not.toContain("provider/credentials.resolve");
    await session.receive({
      jsonrpc: "2.0",
      id: "credential",
      method: "provider/credentials.resolve",
      sensitive: true,
      params: {
        ...input(),
        context: {
          invocationId: "credential",
          workerId: "worker-a",
          releaseId: "release-a",
          principalId: "principal-a",
          scopeId: "scope-a",
          token: "token-a",
          deadline: Date.now() + 10_000,
        },
      },
    });
    expect(frames[1]).toEqual({
      jsonrpc: "2.0",
      id: "credential",
      sensitive: {
        kind: "provider-credential",
        encoding: "base64",
        data: Buffer.from(canary).toString("base64"),
      },
    });
    expect(frames[1]?.result).toBeUndefined();
    session.close();
  });

  test("rejects a dotted connection ID in config and the classified SDK request", async () => {
    expect(() => parseInfisicalConnectionConfig({ ...configValue(), connectionId: "infisical.production" })).toThrow();
    const transport = new QueueTransport([]);
    const extension = createInfisicalExtension(async () => ({ config: config(), transport }));
    const frames: Array<Record<string, unknown>> = [];
    const session = createSession(extension, frame => { frames.push(JSON.parse(frame) as Record<string, unknown>); });
    await session.receive({
      jsonrpc: "2.0",
      id: "dotted-credential",
      method: "provider/credentials.resolve",
      sensitive: true,
      params: {
        ...input({ connectionId: "infisical.production" }),
        context: {
          invocationId: "dotted-credential",
          workerId: "worker-a",
          releaseId: "release-a",
          principalId: "principal-a",
          scopeId: "scope-a",
          token: "token-a",
          deadline: Date.now() + 10_000,
        },
      },
    });
    expect(frames[0]?.sensitive).toBeUndefined();
    expect(frames[0]?.error).toBeDefined();
    expect(transport.requests).toHaveLength(0);
    session.close();
  });
});
