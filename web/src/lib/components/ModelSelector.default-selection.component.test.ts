/**
 * Integration tests for the picker's UNSET-USER DEFAULT.
 *
 * Mounts the real component with `selected: null` and asserts which pair it
 * hands to `onautoselect`:
 *
 *  - mode "auto" on a chat composer (`allowAuto`) → the Auto sentinel, so the
 *    first turn of a fresh thread is routed server-side;
 *  - mode "first" → `models[0]`, the pre-routing behaviour verbatim (the
 *    operator's revert);
 *  - no `allowAuto` → always `models[0]`, because only a chat composer speaks
 *    the explicit-null wire sentinel;
 *  - `defaultSelection: null` (parent still fetching the setting) → NOTHING is
 *    applied yet. That hold-off is what stops the shipped "auto" default from
 *    winning a race against a `"first"` revert.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import ModelSelector from "./ModelSelector.svelte";
import { AUTO_MODEL, AUTO_PROVIDER } from "$lib/model-selector-logic.js";

const MODELS = [
  {
    provider: "openai",
    model: "gpt-5",
    tier: "balanced",
    costTier: "medium",
    available: true,
    displayName: "GPT-5",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    tier: "powerful",
    costTier: "high",
    available: true,
    displayName: "Opus 4.7",
  },
];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/models")) {
      return new Response(JSON.stringify(MODELS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

async function flushLoad() {
  // loadModels is async; yield twice so the models state mutation and the
  // default-applying effect both settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("ModelSelector · unset-user default", () => {
  test('mode "auto" on a chat composer defaults to the Auto sentinel', async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: "auto",
    });

    await flushLoad();

    expect(onautoselect).toHaveBeenCalledTimes(1);
    expect(onautoselect).toHaveBeenCalledWith(AUTO_PROVIDER, AUTO_MODEL);
  });

  test('mode "first" defaults to models[0] — the pre-routing behaviour', async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: "first",
    });

    await flushLoad();

    expect(onautoselect).toHaveBeenCalledTimes(1);
    expect(onautoselect).toHaveBeenCalledWith("openai", "gpt-5");
  });

  test("without allowAuto the Auto mode still defaults to models[0]", async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      defaultSelection: "auto",
    });

    await flushLoad();

    expect(onautoselect).toHaveBeenCalledWith("openai", "gpt-5");
  });

  test("a picker that passes no mode at all keeps the models[0] default", async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, { selected: null, onselect: vi.fn(), onautoselect });

    await flushLoad();

    expect(onautoselect).toHaveBeenCalledWith("openai", "gpt-5");
  });

  test("nothing is applied while the mode is still loading (null)", async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: null,
    });

    await flushLoad();

    expect(onautoselect).not.toHaveBeenCalled();
  });

  test("the mode arriving after the model list still applies the default", async () => {
    const onautoselect = vi.fn();
    const { rerender } = render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: null,
    });

    await flushLoad();
    expect(onautoselect).not.toHaveBeenCalled();

    // The parent's settings read lands and reverts to the pinned default.
    await rerender({
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: "first",
    });
    await flushLoad();

    expect(onautoselect).toHaveBeenCalledTimes(1);
    expect(onautoselect).toHaveBeenCalledWith("openai", "gpt-5");
  });

  test("an explicit saved selection suppresses the default entirely", async () => {
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: { provider: AUTO_PROVIDER, model: AUTO_MODEL },
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: "first",
    });

    await flushLoad();

    expect(onautoselect).not.toHaveBeenCalled();
  });

  test("an empty model list applies no default and does not crash", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const onautoselect = vi.fn();
    render(ModelSelector, {
      selected: null,
      onselect: vi.fn(),
      onautoselect,
      allowAuto: true,
      defaultSelection: "auto",
    });

    await flushLoad();

    expect(onautoselect).not.toHaveBeenCalled();
  });
});
