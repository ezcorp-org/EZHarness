import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";

// The default model check reads the operator's registrations from settings.
mockDbConnection();

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { referenceModelPin } from "@ezcorp/factory-sdk";
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
import { KEYLESS_TOKEN, ProviderCredentialUnusableError, ProviderNotConfiguredError, type ProviderCredential } from "./credentials";
import { oauthSettingKey } from "./credential-store";
import { encrypt } from "./encryption";
import { deleteSetting, upsertSetting } from "../db/queries/settings";
import * as settingsQueries from "../db/queries/settings";
import { getCredential } from "./credentials";

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
  // The C10 pin itself, so these cases test the pin the reference factories run.
  const LUNA: FactoryProviderPin = referenceModelPin;
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
      requiredCredentialKind: "oauth",
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

  test("a stored login that cannot be used is named as unusable, with its error class, never as not configured (W4H-28)", async () => {
    // Connected, but expired with no refresh token: the ladder cannot derive a key from it.
    await upsertSetting(oauthSettingKey(LUNA.provider), encrypt(JSON.stringify({ access: OAUTH_TOKEN, refresh: "", expires: Date.now() - 60_000 })));
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
    expect(readiness).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_credential_unusable"], credentialFailure: { errorClass: "OAuthUnusableError" } });
    const record = factoryProviderReadinessRecord(readiness);
    expect(record).toMatchObject({ failures: ["provider_credential_unusable"], credentialFailure: { errorClass: "OAuthUnusableError" } });
    expect(JSON.stringify(record)).not.toContain(OAUTH_TOKEN);
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/factory_provider_not_ready: openai\/gpt-6-luna \(provider_credential_unusable\)/);
    expect(sent).toHaveLength(0);
  });

  test("a key derivation error carries its class and code into the readiness, and nothing else of it", async () => {
    const derivation = Object.assign(new Error(`OAuth auth derivation failed for openai-codex: ${OAUTH_TOKEN}`), { name: "ModelsError", code: "oauth" });
    const unusable = new ProviderCredentialUnusableError("openai", derivation);
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW, resolveCredential: async () => { throw unusable; } });
    expect(readiness).toMatchObject({ failures: ["provider_credential_unusable"], credentialFailure: { errorClass: "ModelsError", code: "oauth" } });
    expect(JSON.stringify(factoryProviderReadinessRecord(readiness))).not.toContain(OAUTH_TOKEN);
    // Only the ladder's typed "nothing configured" refusal is "not configured".
    const absent = await factoryProviderReadiness(LUNA, { now: () => NOW, resolveCredential: async () => { throw new ProviderNotConfiguredError("openai"); } });
    expect(absent).toMatchObject({ failures: ["provider_not_configured"] });
    expect(absent).not.toHaveProperty("credentialFailure");
    expect(absent).not.toHaveProperty("readinessFailure");
  });

  test("an error reading the credential is a readiness error with its deepest class and code, never \"not configured\" (W4H-28, C10)", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED postgres://admin:fixture-pw@127.0.0.1:5432"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" });
    const failed = new Error("Failed query: select value from settings where key = $1", { cause: refused });
    const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW, resolveCredential: async () => { throw failed; } });
    expect(readiness).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_readiness_error"], readinessFailure: { errorClass: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" } });
    expect(readiness).not.toHaveProperty("credentialFailure");
    const record = factoryProviderReadinessRecord(readiness);
    expect(record).toMatchObject({ failures: ["provider_readiness_error"], readinessFailure: { errorClass: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" } });
    expect(JSON.stringify(record)).not.toContain("fixture-pw");
    expect(JSON.stringify(record)).not.toContain("Failed query");
    // A thrown non-Error has a class and no code.
    const odd = await factoryProviderReadiness(LUNA, { now: () => NOW, resolveCredential: async () => { throw "store down"; } });
    expect(odd).toMatchObject({ failures: ["provider_readiness_error"], readinessFailure: { errorClass: "string" } });
    expect(odd.readinessFailure).not.toHaveProperty("code");
  });

  test("the broker's call-time read names a readiness error the same way, and sends nothing", async () => {
    let reads = 0;
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({
      pin: LUNA, now: () => NOW, stream: capturing(sent),
      resolveCredential: async () => { reads += 1; if (reads === 1) return { type: "oauth", token: OAUTH_TOKEN }; throw Object.assign(new Error("Connection closed"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }); },
    });
    const error = await broker.stream(request({ model: model(LUNA.provider, LUNA.model) })).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(FactoryProviderReadinessError);
    expect((error as FactoryProviderReadinessError).readiness).toMatchObject({ failures: ["provider_readiness_error"], readinessFailure: { errorClass: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" } });
    expect(sent).toHaveLength(0);
  });

  describe("the ladder classifies every step (P-F3, C10)", () => {
    const KEY_PIN: FactoryProviderPin = { provider: "openai", model: "gpt-4.1-mini" };
    /** A row the current secret cannot decrypt: what a rotated or wrong web secret leaves behind. */
    const unreadableRow = () => upsertSetting(oauthSettingKey(LUNA.provider), "v1:000000000000000000000000:00000000000000000000000000000000:00");
    const ACCESS_MODE = "provider:accessMode:openai";
    afterEach(async () => { await deleteSetting(ACCESS_MODE); });
    /** The OAuth-row read alone fails, as a database would; every other settings read works. */
    async function withOAuthRowReadFailing<T>(run: () => Promise<T>): Promise<T> {
      const real = settingsQueries.getSetting;
      const spy = spyOn(settingsQueries, "getSetting").mockImplementation(async (key: string) => {
        if (key === oauthSettingKey(LUNA.provider)) throw new Error("Failed query: select", { cause: Object.assign(new Error("Connection closed"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }) });
        return real(key);
      });
      try { return await run(); } finally { spy.mockRestore(); }
    }

    test("P-F3a: an explicit access mode with nothing stored is not configured, by the typed refusal with the same message", async () => {
      await upsertSetting(ACCESS_MODE, "oauth");
      const oauth = await getCredential("openai").then(() => undefined, (e: unknown) => e);
      expect(oauth).toBeInstanceOf(ProviderNotConfiguredError);
      expect((oauth as Error).message).toBe("No OAuth token for openai");
      expect(await factoryProviderReadiness(LUNA, { now: () => NOW })).toMatchObject({ failures: ["provider_not_configured"] });
      await upsertSetting(ACCESS_MODE, "apikey");
      const key = await getCredential("openai").then(() => undefined, (e: unknown) => e);
      expect(key).toBeInstanceOf(ProviderNotConfiguredError);
      expect((key as Error).message).toBe("Missing API key for openai");
      expect(await factoryProviderReadiness(KEY_PIN, { now: () => NOW, isAvailableModel: () => true })).toMatchObject({ failures: ["provider_not_configured"] });
    });

    test("P-F3b: a stored OAuth row the secret cannot decrypt is unusable, never not configured", async () => {
      await unreadableRow();
      const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
      expect(readiness).toMatchObject({ ready: false, failures: ["provider_credential_unusable"], credentialFailure: { errorClass: "OAuthUnusableError" } });
      await upsertSetting(oauthSettingKey(LUNA.provider), encrypt("not json"));
      expect(await factoryProviderReadiness(LUNA, { now: () => NOW })).toMatchObject({ failures: ["provider_credential_unusable"] });
    });

    test("P-F3b: a database error on the OAuth-row read alone is a readiness error, at readiness, in the record and at the call", async () => {
      await withOAuthRowReadFailing(async () => {
        const readiness = await factoryProviderReadiness(LUNA, { now: () => NOW });
        expect(readiness).toMatchObject({ failures: ["provider_readiness_error"], readinessFailure: { errorClass: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" } });
        expect(factoryProviderReadinessRecord(readiness)).toMatchObject({ failures: ["provider_readiness_error"] });
        const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
        const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
        await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/provider_readiness_error/);
        expect(sent).toHaveLength(0);
      });
    });

    test("an unreadable OAuth row with a valid key: ready on the key, with the broken login as one warning", async () => {
      await unreadableRow();
      await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
      const readiness = await factoryProviderReadiness(KEY_PIN, { now: () => NOW, isAvailableModel: () => true });
      expect(readiness).toMatchObject({ ready: true, credentialKind: "apikey", failures: [], warnings: [{ code: "provider_credential_unusable", credentialFailure: { errorClass: "OAuthUnusableError" } }] });
      const record = factoryProviderReadinessRecord(readiness);
      expect(record).toMatchObject({ warnings: [{ code: "provider_credential_unusable", credentialFailure: { errorClass: "OAuthUnusableError" } }] });
      expect(JSON.stringify(record)).not.toContain(API_KEY);
    });

    test("a database error on the OAuth-row read with a valid key refuses at once; the key is not consulted", async () => {
      await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
      await withOAuthRowReadFailing(async () => {
        expect(await factoryProviderReadiness(KEY_PIN, { now: () => NOW, isAvailableModel: () => true })).toMatchObject({ ready: false, credentialKind: null, failures: ["provider_readiness_error"] });
      });
    });

    test("a login with no usable OAuth key and nothing else configured still reads not configured, and a healthy pin carries no warnings", async () => {
      expect(await factoryProviderReadiness(LUNA, { now: () => NOW })).toMatchObject({ failures: ["provider_not_configured"] });
      await signIn();
      expect(await factoryProviderReadiness(LUNA, { now: () => NOW })).not.toHaveProperty("warnings");
    });
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

  test("an API key alone cannot run the OAuth-only pin: refused by name, never sent", async () => {
    // Since pi-ai 0.87.1 the api-key catalog serves gpt-6-luna too, so the model no longer keeps a
    // key off the public endpoint. The pin's required credential kind does: C10 runs on the
    // ChatGPT-plan login (W10c, the user's decision), never on API billing.
    expect(getModel("openai" as never, LUNA.model as never)).toBeDefined();
    await upsertSetting(API_KEY_SETTING, encrypt(API_KEY));
    expect(await factoryProviderReadiness(LUNA, { now: () => NOW })).toMatchObject({ ready: false, credentialKind: "apikey", requiredCredentialKind: "oauth", failures: ["credential_kind_required"] });
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({ pin: LUNA, stream: capturing(sent) });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/gpt-6-luna \(credential_kind_required\)/);
    expect(sent).toHaveLength(0);
    // The requirement is the pin's, not the model's: a pin that names no kind still runs on the key.
    expect(await factoryProviderReadiness({ provider: LUNA.provider, model: LUNA.model }, { now: () => NOW })).toMatchObject({ ready: true, credentialKind: "apikey", failures: [] });
  });

  test("an API key that replaces the login between readiness and the call is refused at call time, never sent", async () => {
    let reads = 0;
    const sent: Array<{ model: Model<Api>; options: { apiKey?: string } }> = [];
    const broker = createFactoryProviderBroker({
      pin: LUNA,
      resolveCredential: async () => { reads += 1; return reads === 1 ? { type: "oauth", token: OAUTH_TOKEN } : { type: "apikey", token: API_KEY }; },
      stream: capturing(sent),
    });
    await expect(broker.stream(request({ model: model(LUNA.provider, LUNA.model) }))).rejects.toThrow(/gpt-6-luna \(credential_kind_required\)/);
    expect(reads).toBe(2);
    expect(sent).toHaveLength(0);
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
