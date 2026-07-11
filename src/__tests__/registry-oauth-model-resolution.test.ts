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
import { resolveModelObject } from "../providers/registry";
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
