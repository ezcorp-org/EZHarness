/**
 * Regression guard for the OAuth model resolution bug.
 *
 * Reproduces the live-repro failure: a conversation using `gpt-5.5` via
 * ChatGPT subscription arrives at `resolveModelObject` with
 * provider="openai" (the public id the client sends) + model="gpt-5.5".
 * The pi-ai registry doesn't know that id, and the LOCAL_OAUTH_OVERRIDES
 * table registers it under provider="openai-codex" (the OAuth variant).
 *
 * Before the fix, resolveModelObject fell straight through to its
 * "custom model" fallback which hardcodes `input: ["text"]` — dropping
 * the `"image"` flag. `getCapabilities` then reported
 * `kinds: ["text","pdf"]`, causing the history rehydrator to skip every
 * image-generation conversation with "skipped: model lacks image input
 * capability" in the logs. The model never saw prior images, and users
 * couldn't iterate on generated images at all.
 *
 * After the fix, resolveModelObject consults the OAuth map as a
 * fallback and returns the full override definition.
 */

import { test, expect, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/settings", () => ({
  getSetting: mock(() => Promise.resolve(undefined)),
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

import { getModels } from "@earendil-works/pi-ai/compat";
import { credentialServesModel, getOAuthModelIds, resolveModelForCredential, resolveModelObject, resolveOAuthModel } from "../providers/registry";
import { getCapabilities } from "../providers/model-capabilities";

test("resolveModelObject('openai', 'gpt-5.5') falls back to OAuth override", () => {
  const m = resolveModelObject("openai", "gpt-5.5");
  expect(m.id).toBe("gpt-5.5");
  // The override carries the full definition — the generic fallback
  // hardcodes input: ["text"] which would fail this assertion.
  expect(m.input).toContain("image");
  expect(m.input).toContain("text");
  expect(m.reasoning).toBe(true);
});

test("getCapabilities('openai', 'gpt-5.5') reports image support", () => {
  const caps = getCapabilities("openai", "gpt-5.5");
  // The history rehydrator gates on exactly this check —
  // `caps.kinds.includes("image")` — so regression here would
  // silently break image rehydration for the OAuth flow.
  expect(caps.kinds).toContain("image");
  expect(caps.deliveryFor.image).toBe("native-image");
});

// Case 2 (unknown provider + unknown id → unchanged legacy fallback) and
// case 4 (OAuth override wins before any synthetic fallback) are covered by
// this test and the two gpt-5.5 tests above, respectively.
test("unknown provider+model still falls through to generic fallback (no regression)", () => {
  const m = resolveModelObject("some-random-provider", "some-random-id");
  // Hits the custom-model fallback: openai-compat shape, text-only.
  expect(m.id).toBe("some-random-id");
  expect(m.input).toEqual(["text"]);
  expect(m.api).toBe("openai-completions");
  expect(m.baseUrl).toBe("https://api.openai.com/v1");
});

test("known provider + unknown id borrows the provider's native wire shape", () => {
  // A persisted id pi-ai has since dropped (the concrete case: pi-ai 0.80.6
  // retired claude-3-5-sonnet-20241022 on provider "anthropic"). No catalog
  // match, no OAuth override, no explicit baseUrl → synthesize with anthropic's
  // OWN api + baseUrl instead of the openai-completions default that would
  // misroute the call to api.openai.com with Anthropic credentials.
  const sibling = getModels("anthropic")[0]!;
  const m = resolveModelObject("anthropic", "claude-3-5-sonnet-20241022");
  expect(m.id).toBe("claude-3-5-sonnet-20241022");
  expect(m.api).toBe(sibling.api);
  expect(m.api).not.toBe("openai-completions");
  // Borrowed verbatim from the sibling — NOT put through the /v1 munging.
  expect(m.baseUrl).toBe(sibling.baseUrl);
  // Conservative capability floor is preserved.
  expect(m.input).toEqual(["text"]);
  expect(m.reasoning).toBe(false);
});

test("explicit baseUrl on a known provider keeps the legacy openai-completions path", () => {
  // An explicit baseUrl (custom/local endpoint, or the ezcorp-mock test
  // provider) must bypass the sibling-borrow branch even for a catalog
  // provider — the custom-BYOK openai-compat shape + /v1 munging is preserved.
  const m = resolveModelObject("anthropic", "my-local-model", "http://localhost:11434");
  expect(m.api).toBe("openai-completions");
  expect(m.baseUrl).toBe("http://localhost:11434/v1");
  expect(m.input).toEqual(["text"]);
});

test("does NOT borrow an EMPTY sibling baseUrl (azure-openai-responses)", () => {
  // azure-openai-responses' catalog models carry baseUrl "" (filled per
  // request from the Azure resource config). Borrowing "" would dial an
  // empty endpoint, so the hardened branch must skip the borrow and fall
  // through to the non-templated legacy fallback instead.
  const sibling = getModels("azure-openai-responses")[0];
  expect(sibling?.baseUrl).toBe(""); // guards the precondition this test relies on
  const m = resolveModelObject("azure-openai-responses", "no-such-azure-model");
  expect(m.api).toBe("openai-completions");
  expect(m.baseUrl).toBe("https://api.openai.com/v1");
});

test("does NOT borrow a TEMPLATED sibling baseUrl (google-vertex {location})", () => {
  // google-vertex ships baseUrl "https://{location}-aiplatform.googleapis.com"
  // — a still-templated placeholder. Borrowing it verbatim would produce a
  // model that dials a literal "{location}" host, so the borrow is skipped and
  // the legacy fallback (a concrete URL) is used.
  const sibling = getModels("google-vertex")[0];
  expect(sibling?.baseUrl).toContain("{"); // guards the precondition
  const m = resolveModelObject("google-vertex", "no-such-vertex-model");
  expect(m.api).toBe("openai-completions");
  expect(m.baseUrl).toBe("https://api.openai.com/v1");
});

// W10c (C10 revision 2026-10-03): the factory pin gpt-5.6-luna is served by a ChatGPT-plan
// OAuth login. pi-ai 0.85.1 ships the id in its openai-codex catalog, so no local override is
// needed; these cases prove the registry routes it the way the factory broker relies on.
test("gpt-5.6-luna resolves for the openai OAuth login to the subscription endpoint, from pi-ai's own catalog", () => {
  expect(getOAuthModelIds("openai")?.has("gpt-5.6-luna")).toBe(true);
  expect(resolveOAuthModel("openai", "gpt-5.6-luna")).toMatchObject({
    id: "gpt-5.6-luna",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 272_000,
    maxTokens: 128_000,
  });
});

test("an OAuth credential swaps the catalog model to its subscription sibling; an API key keeps the api-key wire", () => {
  const catalog = resolveModelObject("openai", "gpt-5.6-luna");
  expect(catalog).toMatchObject({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
  expect(resolveModelForCredential(catalog, "openai", "oauth")).toMatchObject({ id: "gpt-5.6-luna", provider: "openai", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" });
  expect(resolveModelForCredential(catalog, "openai", "apikey")).toBe(catalog);
});

test("credentialServesModel names which credential kinds can run a model, and agrees with the swap", () => {
  expect(credentialServesModel("openai", "gpt-5.6-luna", "oauth")).toBe(true);
  expect(credentialServesModel("openai", "gpt-5.6-luna", "apikey")).toBe(true);
  // An api-key-only id: the subscription endpoint does not serve it.
  expect(credentialServesModel("openai", "gpt-4.1-mini", "oauth")).toBe(false);
  expect(credentialServesModel("openai", "gpt-4.1-mini", "apikey")).toBe(true);
  expect(credentialServesModel("openai", "gpt-5.6-lunna", "oauth")).toBe(false);
  // Anthropic's OAuth uses its ordinary catalog, so its token is never refused here.
  expect(credentialServesModel("anthropic", "claude-haiku-4-5-20251001", "oauth")).toBe(true);
  expect(() => resolveModelForCredential(resolveModelObject("openai", "gpt-4.1-mini"), "openai", "oauth")).toThrow(/not supported with openai OAuth/);
});
