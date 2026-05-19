import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  loadExtensionSettings,
  getCachedSettings,
  invalidateExtensionSettings,
  __resetExtensionSettingsCacheForTests,
} from "./extensionSettings";

type FetchInput = RequestInfo | URL;
type FetchResponder = (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function setupFetch(responder: FetchResponder): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: FetchInput) => responder(String(input)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  __resetExtensionSettingsCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadExtensionSettings", () => {
  test("happy path: resolves id then settings, caches resolved blob", async () => {
    const fetchMock = setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      if (url === "/api/extensions/ext-1/settings") {
        return jsonResponse({ resolved: { voice: "bf_emma", speed: 1.5 } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loadExtensionSettings("kokoro-tts");

    expect(result).toEqual({ voice: "bf_emma", speed: 1.5 });
    expect(getCachedSettings("kokoro-tts")).toEqual({
      voice: "bf_emma",
      speed: 1.5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("cache hit: second call returns cached value without refetching", async () => {
    const fetchMock = setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return jsonResponse({ resolved: { voice: "af_bella" } });
    });

    await loadExtensionSettings("kokoro-tts");
    fetchMock.mockClear();
    const second = await loadExtensionSettings("kokoro-tts");

    expect(second).toEqual({ voice: "af_bella" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("force: bypasses cache and refetches", async () => {
    let voice = "af_bella";
    const fetchMock = setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return jsonResponse({ resolved: { voice } });
    });

    await loadExtensionSettings("kokoro-tts");
    voice = "bm_george";
    const refreshed = await loadExtensionSettings("kokoro-tts", { force: true });

    expect(refreshed).toEqual({ voice: "bm_george" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("inflight de-dupe: concurrent calls share one promise", async () => {
    let resolveSettings!: (r: Response) => void;
    const settingsPromise = new Promise<Response>((r) => {
      resolveSettings = r;
    });
    const fetchMock = setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return settingsPromise;
    });

    const a = loadExtensionSettings("kokoro-tts");
    const b = loadExtensionSettings("kokoro-tts");
    resolveSettings(jsonResponse({ resolved: { voice: "af_sarah" } }));

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    const lookupCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/extensions?name="),
    );
    expect(lookupCalls).toHaveLength(1);
  });

  test("lookup response shape {extensions:[...]} also accepted", async () => {
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse({
          extensions: [{ id: "ext-2", name: "kokoro-tts" }],
        });
      }
      return jsonResponse({ resolved: { voice: "am_adam" } });
    });

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({ voice: "am_adam" });
  });

  test("lookup non-200 → caches empty, returns {}", async () => {
    setupFetch(() => new Response("nope", { status: 500 }));

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({});
    expect(getCachedSettings("kokoro-tts")).toEqual({});
  });

  test("lookup name mismatch → caches empty, returns {}", async () => {
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "x", name: "something-else" }]);
      }
      throw new Error("settings fetch should not run");
    });

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({});
    expect(getCachedSettings("kokoro-tts")).toEqual({});
  });

  test("settings fetch non-200 → caches empty, returns {}", async () => {
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return new Response("err", { status: 500 });
    });

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({});
  });

  test("settings response missing 'resolved' → returns {}", async () => {
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return jsonResponse({ schema: null });
    });

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({});
  });

  test("fetch throws → caught, returns {}", async () => {
    setupFetch(() => {
      throw new Error("network down");
    });

    const result = await loadExtensionSettings("kokoro-tts");
    expect(result).toEqual({});
    expect(getCachedSettings("kokoro-tts")).toEqual({});
  });
});

describe("getCachedSettings", () => {
  test("returns undefined for never-loaded extension", () => {
    expect(getCachedSettings("not-loaded")).toBeUndefined();
  });

  test("returns cached value after load", async () => {
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return jsonResponse({ resolved: { voice: "bf_emma" } });
    });
    await loadExtensionSettings("kokoro-tts");
    expect(getCachedSettings("kokoro-tts")).toEqual({ voice: "bf_emma" });
  });
});

describe("invalidateExtensionSettings", () => {
  test("clears cache entry; subsequent load refetches", async () => {
    let voice = "af_bella";
    setupFetch((url) => {
      if (url.includes("/api/extensions?name=")) {
        return jsonResponse([{ id: "ext-1", name: "kokoro-tts" }]);
      }
      return jsonResponse({ resolved: { voice } });
    });

    await loadExtensionSettings("kokoro-tts");
    expect(getCachedSettings("kokoro-tts")).toEqual({ voice: "af_bella" });

    voice = "am_adam";
    invalidateExtensionSettings("kokoro-tts");
    expect(getCachedSettings("kokoro-tts")).toBeUndefined();

    const refreshed = await loadExtensionSettings("kokoro-tts");
    expect(refreshed).toEqual({ voice: "am_adam" });
  });

  test("is a no-op on absent entry", () => {
    expect(() => invalidateExtensionSettings("never-loaded")).not.toThrow();
    expect(getCachedSettings("never-loaded")).toBeUndefined();
  });
});
