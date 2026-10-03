import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";

// The default model check reads the operator's registrations from settings.
mockDbConnection();

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { FactoryBrokerRequest } from "../runtime/factory-execution";
import {
  createFactoryProviderBroker,
  factoryProviderReadiness,
  factoryProviderReadinessRecord,
  FactoryProviderReadinessError,
  FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
  isFactoryServableModel,
  type FactoryProviderPin,
} from "./factory-broker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYLESS_TOKEN, type ProviderCredential } from "./credentials";
import { oauthSettingKey } from "./credential-store";
import { encrypt } from "./encryption";
import { deleteSetting, upsertSetting } from "../db/queries/settings";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(async () => { await deleteSetting("provider:customModels"); });

const OLLAMA: FactoryProviderPin = { provider: "ollama", model: "qwen3:1.7b" };
/** Exactly the row the settings page writes when an operator adds a local Ollama model. */
const registerOllama = () => upsertSetting("provider:customModels", [{ modelId: OLLAMA.model, provider: OLLAMA.provider, tier: "balanced", baseUrl: "http://127.0.0.1:11434" }]);

const PIN: FactoryProviderPin = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const NOW = Date.parse("2026-09-14T00:00:00.000Z");
const KEY: ProviderCredential = { type: "apikey", token: "resolved-by-reference" };

const model = (provider: string, id: string): Model<Api> => ({ provider, id } as Model<Api>);

function request(overrides: Partial<FactoryBrokerRequest> = {}): FactoryBrokerRequest {
  return {
    attemptToken: "attempt-token",
    operation: { operationId: "op:1", operationIndex: 1, kind: "model", requestDigest: "0".repeat(64), state: "prepared" },
    model: model(PIN.provider, PIN.model),
    context: { messages: [] },
    options: {},
    ...overrides,
  };
}

function answering(text: string) {
  return ((_model: Model<Api>, _context: unknown, options?: { apiKey?: string }) => {
    const message = {
      role: "assistant", content: [{ type: "text", text: `${text}:${options?.apiKey ?? "none"}` }],
      api: "anthropic-messages", provider: PIN.provider, model: PIN.model,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 0,
    } as unknown as AssistantMessage;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.end(message);
    return stream;
  }) as never;
}

describe("factory provider readiness", () => {
  test("is ready when the deployment has both the pinned model and a credential", async () => {
    const readiness = await factoryProviderReadiness(PIN, {
      isAvailableModel: () => true,
      resolveCredential: async () => KEY,
      now: () => NOW,
    });
    expect(readiness).toEqual({
      schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
      provider: PIN.provider,
      model: PIN.model,
      ready: true,
      credentialKind: "apikey",
      failures: [],
      checkedAtMs: NOW,
    });
  });

  test("names a missing model and a missing credential separately, and both together", async () => {
    const noModel = await factoryProviderReadiness(PIN, { isAvailableModel: () => false, resolveCredential: async () => KEY, now: () => NOW });
    expect(noModel.failures).toEqual(["model_not_available"]);
    expect(noModel.ready).toBe(false);
    expect(noModel.credentialKind).toBe("apikey");

    const noCredential = await factoryProviderReadiness(PIN, { isAvailableModel: () => true, resolveCredential: async () => null, now: () => NOW });
    expect(noCredential.failures).toEqual(["provider_not_configured"]);
    expect(noCredential.credentialKind).toBeNull();

    const neither = await factoryProviderReadiness(PIN, { isAvailableModel: () => false, resolveCredential: async () => null, now: () => NOW });
    expect(neither.failures).toEqual(["model_not_available", "provider_not_configured"]);
  });

  test("resolves the contract's pinned model against the application's real catalog", async () => {
    // No credential is asserted here; deployments differ. The model pin must resolve regardless.
    const readiness = await factoryProviderReadiness(PIN, { resolveCredential: async () => null, now: () => NOW });
    expect(readiness.failures).not.toContain("model_not_available");
    const retired = await factoryProviderReadiness({ provider: "anthropic", model: "claude-retired-0-0-19000101" }, { resolveCredential: async () => null, now: () => NOW });
    expect(retired.failures).toContain("model_not_available");
  });

  test("the evidence record carries no credential value", async () => {
    const readiness = await factoryProviderReadiness(PIN, { isAvailableModel: () => true, resolveCredential: async () => KEY, now: () => NOW });
    const record = factoryProviderReadinessRecord(readiness);
    expect(record).toEqual({
      schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
      provider: PIN.provider,
      model: PIN.model,
      ready: true,
      credentialKind: "apikey",
      failures: [],
      checkedAt: new Date(NOW).toISOString(),
    });
    expect(JSON.stringify(record)).not.toContain(KEY.token);
  });
});

describe("the factory provider broker", () => {
  test("calls the provider with the deployment's own credential, which the runner never sent", async () => {
    const broker = createFactoryProviderBroker({
      pin: PIN,
      isAvailableModel: () => true,
      resolveCredential: async () => KEY,
      resolveModel: model,
      stream: answering("answered"),
    });
    const stream = await broker.stream(request());
    const message = await stream.result();
    expect((message.content[0] as { text: string }).text).toBe(`answered:${KEY.token}`);
    expect(Object.keys(request().options)).not.toContain("apiKey");
  });

  test("applies the keyless rule: the placeholder sends no Authorization, a real key no header override", async () => {
    // #315: a keyless credential must never reach the wire as `Bearer no-key-needed`.
    // keyless-auth-header.test.ts proves on the wire that `Authorization: null` suppresses the header.
    const sent: unknown[] = [];
    const capture = ((resolved: Model<Api>, context: unknown, options: unknown) => {
      sent.push(options);
      return (answering("x") as unknown as (...args: unknown[]) => unknown)(resolved, context, options);
    }) as never;
    const call = async (credential: ProviderCredential) => {
      const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => credential, resolveModel: model, stream: capture });
      await (await broker.stream(request({ options: { reasoning: "low" } }))).result();
    };
    await call({ type: "apikey", token: KEYLESS_TOKEN });
    await call(KEY);
    expect(sent).toEqual([
      { reasoning: "low", apiKey: KEYLESS_TOKEN, headers: { Authorization: null } },
      { reasoning: "low", apiKey: KEY.token },
    ]);
  });

  test("refuses a runner that names a model other than the pinned one", async () => {
    const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => KEY, resolveModel: model, stream: answering("x") });
    await expect(broker.stream(request({ model: model("anthropic", "claude-opus-5") }))).rejects.toThrow(/model_pin_mismatch/);
    await expect(broker.stream(request({ model: model("openai", PIN.model) }))).rejects.toThrow(/model_pin_mismatch/);
  });

  test("refuses to run at all when the deployment is not ready, rather than substituting anything", async () => {
    const missing = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => null, resolveModel: model, stream: answering("x") });
    await expect(missing.stream(request())).rejects.toThrow(/factory_provider_not_ready: anthropic\/claude-haiku-4-5-20251001 \(provider_not_configured\)/);

    const retired = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => false, resolveCredential: async () => KEY, resolveModel: model, stream: answering("x") });
    await expect(retired.stream(request())).rejects.toThrow(/model_not_available/);
  });

  test("refuses when the credential disappears between the readiness check and the call", async () => {
    let calls = 0;
    const broker = createFactoryProviderBroker({
      pin: PIN,
      isAvailableModel: () => true,
      resolveCredential: async () => { calls += 1; return calls === 1 ? KEY : null; },
      resolveModel: model,
      stream: answering("x"),
    });
    await expect(broker.stream(request())).rejects.toThrow(/provider_not_configured/);
    expect(calls).toBe(2);
  });

  test("the readiness error carries the full record for an evidence file", async () => {
    const broker = createFactoryProviderBroker({ pin: PIN, isAvailableModel: () => true, resolveCredential: async () => null, resolveModel: model, stream: answering("x") });
    const error = await broker.stream(request()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FactoryProviderReadinessError);
    expect((error as FactoryProviderReadinessError).readiness.failures).toEqual(["provider_not_configured"]);
    expect((error as FactoryProviderReadinessError).name).toBe("FactoryProviderReadinessError");
  });
});

describe("a local model the operator registered", () => {
  test("is servable once registered with an endpoint, and not before", async () => {
    expect(await isFactoryServableModel(OLLAMA.provider, OLLAMA.model)).toBe(false);
    await registerOllama();
    expect(await isFactoryServableModel(OLLAMA.provider, OLLAMA.model)).toBe(true);
    // Another model on the same local provider is not registered by this row.
    expect(await isFactoryServableModel(OLLAMA.provider, "qwen3:8b")).toBe(false);
  });

  test("makes the pin ready through the application's own credential path, which needs no key for a local endpoint", async () => {
    const before = await factoryProviderReadiness(OLLAMA, { now: () => NOW });
    expect(before.failures).toEqual(["model_not_available", "provider_not_configured"]);
    await registerOllama();
    const after = await factoryProviderReadiness(OLLAMA, { now: () => NOW });
    expect(after).toMatchObject({ ready: true, failures: [], credentialKind: "apikey" });
  });

  test("is called at its registered endpoint, never at a default one", async () => {
    await registerOllama();
    const sent: Model<Api>[] = [];
    const broker = createFactoryProviderBroker({
      pin: OLLAMA,
      resolveCredential: async () => KEY,
      stream: ((resolved: Model<Api>, context: unknown, options: unknown) => { sent.push(resolved); return (answering("local") as unknown as (...args: unknown[]) => unknown)(resolved, context, options); }) as never,
    });
    const answered = await (await broker.stream(request({ model: model(OLLAMA.provider, OLLAMA.model) }))).result();
    expect((answered.content[0] as { text: string }).text).toBe(`local:${KEY.token}`);
    expect(sent[0]).toMatchObject({ id: OLLAMA.model, provider: OLLAMA.provider, api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" });
  });
});

describe("the openai pin under a ChatGPT-plan OAuth login (C10 revision, W10c)", () => {
  const LUNA: FactoryProviderPin = { provider: "openai", model: "gpt-6-luna" };
  const OAUTH_TOKEN = "fixture-oauth-token";
  const API_KEY = "fixture-api-key";
  const API_KEY_SETTING = "provider:apiKey:openai";
  // encrypt() persists a generated key beside the database, which for :memory: is the cwd.
  // A private folder keeps the fixture key out of the checkout.
  const secretsDir = mkdtempSync(join(tmpdir(), "w10c-secrets-"));
  const previousSecretsDir = process.env.EZCORP_SECRETS_DIR;

  /** Exactly the row the app's own sign-in flow writes, holding only fixture strings. */
  const signIn = () => upsertSetting(oauthSettingKey(LUNA.provider), encrypt(JSON.stringify({ access: OAUTH_TOKEN, refresh: "fixture-refresh-token", expires: Date.now() + 3_600_000 })));

  beforeAll(() => { process.env.EZCORP_SECRETS_DIR = secretsDir; });
  afterAll(() => {
    if (previousSecretsDir === undefined) delete process.env.EZCORP_SECRETS_DIR;
    else process.env.EZCORP_SECRETS_DIR = previousSecretsDir;
    rmSync(secretsDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await deleteSetting(oauthSettingKey(LUNA.provider));
    await deleteSetting(API_KEY_SETTING);
  });

  function capturing(sent: Array<{ model: Model<Api>; options: { apiKey?: string } }>) {
    return ((resolved: Model<Api>, context: unknown, options: { apiKey?: string }) => {
      sent.push({ model: resolved, options });
      return (answering("luna") as unknown as (...args: unknown[]) => unknown)(resolved, context, options);
    }) as never;
  }

  test("is ready on the stored OAuth credential, and names only its kind", async () => {
    await signIn();
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
    expect(readiness).toEqual({
      schemaVersion: FACTORY_PROVIDER_READINESS_SCHEMA_VERSION,
      provider: "openai",
      model: "gpt-6-luna",
      ready: true,
      credentialKind: "oauth",
      failures: [],
      checkedAtMs: NOW,
    });
    expect(JSON.stringify(factoryProviderReadinessRecord(readiness))).not.toContain(OAUTH_TOKEN);
  });

  test("sends the call to the ChatGPT subscription endpoint with the OAuth token, never the api-key wire", async () => {
    await signIn();
    // A BYOK key is configured as well. The OAuth login wins, and the key is never what is sent.
    await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    const answered = await (await broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).result();
    expect((answered.content[0] as { text: string }).text).toBe(`luna:${OAUTH_TOKEN}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.model).toMatchObject({
      id: "gpt-6-luna",
      // The public provider name stays, so later credential lookups still read the openai row.
      provider: "openai",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text", "image"],
      contextWindow: 272_000,
    });
    expect(sent[0]!.options.apiKey).toBe(OAUTH_TOKEN);
  });

  test("serves concurrent calls each through the OAuth path", async () => {
    await signIn();
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    const answers = await Promise.all([1, 2, 3].map(async () => (await broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).result()));
    expect(answers.map((a) => (a.content[0] as { text: string }).text)).toEqual([1, 2, 3].map(() => `luna:${OAUTH_TOKEN}`));
    expect(sent.map((s) => [s.model.api, s.options.apiKey])).toEqual([1, 2, 3].map(() => ["openai-codex-responses", OAUTH_TOKEN]));
  });

  test("with no stored credential names the missing credential only, because the model is in the catalog", async () => {
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
    expect(readiness).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_not_configured"] });
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/factory_provider_not_ready: openai\/gpt-6-luna \(provider_not_configured\)/);
    expect(sent).toHaveLength(0);
  });

  test("names a misspelt model id as unavailable, even with the login present", async () => {
    await signIn();
    const misspelt: FactoryProviderPin = { provider: "openai", model: "gpt-6-lunna" };
    const readiness = await factoryProviderReadiness(misspelt, { now: () => NOW });
    expect(readiness).toMatchObject({ ready: false, credentialKind: "oauth", failures: ["model_not_available"] });
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: misspelt, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(misspelt.provider, misspelt.model) }))).rejects.toThrow(/gpt-6-lunna \(model_not_available\)/);
    expect(sent).toHaveLength(0);
  });

  test("refuses by name an api-key-only model the OAuth login cannot serve, instead of sending it to api.openai.com", async () => {
    await signIn();
    const apiKeyOnly: FactoryProviderPin = { provider: "openai", model: "gpt-4.1-mini" };
    const readiness = await factoryProviderReadiness(apiKeyOnly, { now: () => NOW });
    expect(readiness).toMatchObject({ ready: false, credentialKind: "oauth", failures: ["model_not_available"] });
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: apiKeyOnly, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(apiKeyOnly.provider, apiKeyOnly.model) }))).rejects.toThrow(/gpt-4\.1-mini \(model_not_available\)/);
    expect(sent).toHaveLength(0);
    // The same model on an API key is servable: the refusal is about the credential kind.
    await deleteSetting(oauthSettingKey(LUNA.provider));
    await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
    expect(await factoryProviderReadiness(apiKeyOnly, { now: () => NOW })).toMatchObject({ ready: true, credentialKind: "apikey", failures: [] });
  });

  test("regression pair: the same model goes to the subscription endpoint on a login and to the api-key endpoint on a key", async () => {
    // gpt-5.5 is in both catalogs, so only the credential kind decides the wire.
    const both: FactoryProviderPin = { provider: "openai", model: "gpt-5.5" };
    const viaLogin: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    await signIn();
    await (await createFactoryProviderBroker({ pin: both, stream: capturing(viaLogin) }).stream(request({ model: model(both.provider, both.model) }))).result();
    expect(viaLogin[0]!.model).toMatchObject({ id: "gpt-5.5", provider: "openai", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" });
    expect(viaLogin[0]!.model.baseUrl).not.toContain("api.openai.com");

    await deleteSetting(oauthSettingKey(LUNA.provider));
    await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
    const viaKey: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    await (await createFactoryProviderBroker({ pin: both, stream: capturing(viaKey) }).stream(request({ model: model(both.provider, both.model) }))).result();
    expect(viaKey[0]!.model).toMatchObject({ id: "gpt-5.5", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
    expect(viaKey[0]!.options.apiKey).toBe(API_KEY);
  });

  test("an API key alone cannot run the subscription-only pin: named as unavailable, never sent", async () => {
    // gpt-6-luna exists only behind the ChatGPT login; an API key at that endpoint is refused.
    await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
    expect(readiness).toMatchObject({ ready: false, credentialKind: "apikey", failures: ["model_not_available"] });
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/gpt-6-luna \(model_not_available\)/);
    expect(sent).toHaveLength(0);
    // A model both endpoints serve stays runnable on the key.
    expect(await factoryProviderReadiness({ provider: "openai", model: "gpt-5.5" }, { now: () => NOW })).toMatchObject({ ready: true, credentialKind: "apikey" });
  });

  test("a login that disappears between readiness and the call is refused, not sent unauthenticated", async () => {
    await signIn();
    let reads = 0;
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({
      pin: LUNA,
      resolveCredential: async () => { reads += 1; return reads === 1 ? { type: "oauth", token: OAUTH_TOKEN } : null; },
      stream: capturing(sent),
    });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/provider_not_configured/);
    expect(sent).toHaveLength(0);
  });
});
