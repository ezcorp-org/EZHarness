import { afterEach, describe, expect, mock, test } from "bun:test";
import { startAuthKeepalive } from "$lib/auth-keepalive.js";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

function testFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  globalThis.fetch = originalFetch;
});

describe("startAuthKeepalive", () => {
  test("is a no-op without a browser window", () => {
    // @ts-expect-error This Bun process intentionally has no browser global.
    delete globalThis.window;
    const stop = startAuthKeepalive();
    expect(typeof stop).toBe("function");
    stop();
  });

  test("pings only while visible and always clears its interval", async () => {
    let callback: (() => void) | undefined;
    const setInterval = mock((fn: () => void) => {
      callback = fn;
      return 42;
    });
    const clearInterval = mock(() => {});
    const fetchMock = mock<FetchHandler>(() => Promise.resolve(new Response()));
    globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
    globalThis.document = { visibilityState: "visible" } as Document;
    globalThis.fetch = testFetch(fetchMock);

    const stop = startAuthKeepalive();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 20 * 60 * 1000);
    callback?.();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/ping", {
      credentials: "same-origin",
      cache: "no-store",
    });

    globalThis.document = { visibilityState: "hidden" } as Document;
    callback?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    expect(clearInterval).toHaveBeenCalledWith(42);
  });

  test("absorbs a transient ping rejection and continues scheduling", async () => {
    let callback: (() => void) | undefined;
    const setInterval = mock((fn: () => void) => { callback = fn; return 7; });
    const clearInterval = mock(() => {});
    const fetchMock = mock<FetchHandler>(() => Promise.reject(new Error("offline")));
    globalThis.window = { setInterval, clearInterval } as unknown as Window & typeof globalThis;
    globalThis.document = { visibilityState: "visible" } as Document;
    globalThis.fetch = testFetch(fetchMock);

    const stop = startAuthKeepalive();
    callback?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    callback?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 20 * 60 * 1000);
    expect(clearInterval).toHaveBeenCalledWith(7);
  });
});
