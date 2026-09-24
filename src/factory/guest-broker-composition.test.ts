import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";

// The installation's provider resolves the pin through the operator's settings.
mockDbConnection();

import type { FactoryGuestModelRequest, FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { deleteSetting, upsertSetting } from "../db/queries/settings";
import { digestObject } from "../extensions/v4/blobs";
import { factoryLaunchRequest } from "../__tests__/helpers/factory-attempt-launch-fixture";
import { FACTORY_PROVIDER_NOT_CONFIGURED, factoryInstallationModelProvider, factoryUnpinnedModelProvider } from "./guest-broker-composition";

/**
 * The installation's pinned provider, over real HTTP, as the product composes it.
 *
 * The endpoint is a local OpenAI-compatible server standing where the host's
 * Ollama stands, registered through the same settings row the "add a local
 * provider" page writes. Everything between the guest's request and that
 * socket is the product's own code: the pinned resolution, the provider
 * broker's readiness and credential path, pi-ai's completions client, and the
 * one-hop adapter. The server answers the way Ollama 0.21 does, including its
 * missing-model 404, measured against the real one.
 */

const configuration = { temperature: 0, seed: 42, reasoningEffort: "none" };
const pin: FactoryModelPin = {
  provider: "ollama", model: "qwen3:1.7b",
  configuration, configurationDigest: `sha256:${digestObject(configuration)}`,
  policy: {}, policyDigest: `sha256:${digestObject({})}`,
};

interface Seen { readonly path: string; readonly body: Record<string, unknown> }
const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

beforeAll(async () => {
  await setupTestDb();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>;
      seen.push({ path: new URL(request.url).pathname, body });
      if (body.model !== pin.model) {
        return Response.json({ error: { message: `model '${String(body.model)}' not found`, type: "not_found_error", param: null, code: null } }, { status: 404 });
      }
      return sse([
        { id: "chatcmpl-1", object: "chat.completion.chunk", model: pin.model, choices: [{ index: 0, delta: { role: "assistant", content: "Red, green, and blue." }, finish_reason: null }] },
        { id: "chatcmpl-1", object: "chat.completion.chunk", model: pin.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "chatcmpl-1", object: "chat.completion.chunk", model: pin.model, choices: [], usage: { prompt_tokens: 34, completion_tokens: 8, total_tokens: 42 } },
      ]);
    },
  });
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

beforeEach(async () => {
  seen.length = 0;
  await deleteSetting("provider:customModels");
});

const register = (models: readonly string[]) => upsertSetting("provider:customModels", models.map(modelId => ({ modelId, provider: "ollama", tier: "balanced", baseUrl: `http://127.0.0.1:${server.port}` })));

function attempt(model: FactoryModelPin = pin): FactoryRunnerRequest {
  return { ...factoryLaunchRequest({ attemptId: "attempt-installation-provider" }), model } as FactoryRunnerRequest;
}

function ask(model: FactoryModelPin = pin): FactoryGuestModelRequest {
  return { schemaVersion: "factory.guest-model-request.v1", operationId: "run:node:0:0", operationIndex: 0, model, messages: [{ role: "system", text: "Answer in one short sentence." }, { role: "user", text: "Name the primary colours of light." }], maxOutputTokens: 64 };
}

describe("the installation's pinned provider", () => {
  test("sends the pinned model, its sampling, and the guest's turns to the registered endpoint, and measures the reply", async () => {
    await register([pin.model]);
    const provider = await factoryInstallationModelProvider({ provider: pin.provider, model: pin.model });
    const completion = await provider.complete(ask(), attempt());

    expect(completion.text).toBe("Red, green, and blue.");
    expect(completion.usage).toMatchObject({ kind: "measured", inputTokens: 34, outputTokens: 8, costMicros: "0" });
    expect(completion.providerReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.body).toMatchObject({
      model: "qwen3:1.7b", stream: true, temperature: 0, seed: 42, reasoning_effort: "none", max_tokens: 64,
      messages: [{ role: "system", content: "Answer in one short sentence." }, { role: "user", content: [{ type: "text", text: "Name the primary colours of light." }] }],
    });
  });

  test("a model the endpoint does not have is a provider error carrying the endpoint's own message", async () => {
    const missing: FactoryModelPin = { ...pin, model: "qwen3:w19a-missing" };
    await register([missing.model]);
    const provider = await factoryInstallationModelProvider({ provider: missing.provider, model: missing.model });
    await expect(provider.complete(ask(missing), attempt(missing))).rejects.toThrow("model 'qwen3:w19a-missing' not found");
    expect(seen).toHaveLength(1);
  });

  test("a pin nobody registered is refused as not ready before any request leaves the process", async () => {
    const provider = await factoryInstallationModelProvider({ provider: pin.provider, model: pin.model });
    await expect(provider.complete(ask(), attempt())).rejects.toThrow("factory_provider_not_ready: ollama/qwen3:1.7b (model_not_available, provider_not_configured)");
    expect(seen).toHaveLength(0);
  });

  test("an installation with no pin has a provider that fails every call by name", async () => {
    await expect(factoryUnpinnedModelProvider()).rejects.toThrow(`${FACTORY_PROVIDER_NOT_CONFIGURED}: this installation declares no modelProvider`);
  });
});
