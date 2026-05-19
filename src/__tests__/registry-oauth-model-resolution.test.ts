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

test("unknown provider+model still falls through to generic fallback (no regression)", () => {
  const m = resolveModelObject("some-random-provider", "some-random-id");
  // Hits the custom-model fallback: openai-compat shape, text-only.
  expect(m.id).toBe("some-random-id");
  expect(m.input).toEqual(["text"]);
  expect(m.api).toBe("openai-completions");
});
