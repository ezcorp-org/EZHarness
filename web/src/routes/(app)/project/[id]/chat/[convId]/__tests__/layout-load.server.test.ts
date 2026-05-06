/**
 * Layout-load test — proves the conversation layout iterates the enabled
 * extensions list and preloads settings for every extension that declares
 * a non-empty `settings` block (instead of hardcoding kokoro-tts).
 *
 * The layout calls SvelteKit's injected `fetch` once for `/api/extensions`,
 * then delegates each preload to `loadExtensionSettings`, which we mock so
 * we can pin the exact set of names it was asked to load.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const loadExtensionSettings = vi.fn(async (_name: string) => ({}));

vi.mock("$lib/stores/extensionSettings", () => ({
  loadExtensionSettings: (name: string) => loadExtensionSettings(name),
}));

beforeEach(() => {
  loadExtensionSettings.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("conversation +layout.ts load()", () => {
  test("preloads settings for every enabled extension with a non-empty schema", async () => {
    const { load } = await import("../+layout");
    const fetchMock = makeFetch([
      {
        name: "kokoro-tts",
        enabled: true,
        manifest: { settings: { voice: { type: "select" } } },
      },
      {
        name: "claude-design",
        enabled: true,
        manifest: { settings: { theme: { type: "text" } } },
      },
      // Disabled — must be skipped even if it has a schema.
      {
        name: "disabled-ext",
        enabled: false,
        manifest: { settings: { foo: { type: "text" } } },
      },
      // Enabled but no schema — must be skipped.
      { name: "no-schema", enabled: true, manifest: { settings: {} } },
      { name: "no-manifest-settings", enabled: true, manifest: {} },
    ]);

    await (load as any)({ fetch: fetchMock });

    const calls = loadExtensionSettings.mock.calls.map((c) => c[0]).sort();
    expect(calls).toEqual(["claude-design", "kokoro-tts"]);
  });

  test("accepts {extensions: [...]} envelope shape", async () => {
    const { load } = await import("../+layout");
    const fetchMock = makeFetch({
      extensions: [
        {
          name: "kokoro-tts",
          enabled: true,
          manifest: { settings: { voice: { type: "select" } } },
        },
      ],
    });

    await (load as any)({ fetch: fetchMock });

    expect(loadExtensionSettings.mock.calls.map((c) => c[0])).toEqual([
      "kokoro-tts",
    ]);
  });

  test("non-fatal on /api/extensions failure", async () => {
    const { load } = await import("../+layout");
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect((load as any)({ fetch: fetchMock })).resolves.toEqual({});
    expect(loadExtensionSettings).not.toHaveBeenCalled();
  });

  test("non-fatal when individual loadExtensionSettings rejects", async () => {
    const { load } = await import("../+layout");
    loadExtensionSettings.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const fetchMock = makeFetch([
      {
        name: "kokoro-tts",
        enabled: true,
        manifest: { settings: { voice: { type: "select" } } },
      },
    ]);

    await expect((load as any)({ fetch: fetchMock })).resolves.toEqual({});
  });

  test("non-fatal on non-OK /api/extensions response", async () => {
    const { load } = await import("../+layout");
    const fetchMock = makeFetch({}, false);

    await expect((load as any)({ fetch: fetchMock })).resolves.toEqual({});
    expect(loadExtensionSettings).not.toHaveBeenCalled();
  });
});
