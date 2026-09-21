import { afterEach, expect, test, vi } from "vitest";
import { postExtensionEvent } from "../chat/extension-toolbar-action";
import { userFetch } from "./fetch-policy";
import { randomId } from "./random-id";

afterEach(() => vi.unstubAllGlobals());

test("uses fresh secure bytes without randomUUID and preserves UUID version and variant bits", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(getRandomValues.mock.calls.length === 1 ? 0 : 255));
  vi.stubGlobal("crypto", { getRandomValues });
  expect(randomId()).toBe("00000000-0000-4000-8000-000000000000");
  expect(randomId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  expect(getRandomValues).toHaveBeenCalledTimes(2);
  expect(getRandomValues.mock.calls[0]?.[0]).toHaveLength(16);
  expect(getRandomValues.mock.calls[1]?.[0]).not.toBe(getRandomValues.mock.calls[0]?.[0]);
});

test.each(["event", "toolbar"])("%s requests keep their retry key on HTTP", async (caller) => {
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true }));
  vi.stubGlobal("fetch", fetcher);
  const url = "/api/extensions/example/events/run";
  const addToast = vi.fn();
  if (caller === "event") await userFetch(url, { method: "POST" });
  else await postExtensionEvent(url, { messageId: "message", conversationId: "conversation", content: "text", selection: "" }, "Run", { fetcher: userFetch, addToast });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(addToast).not.toHaveBeenCalled();
  const key = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key");
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await userFetch(url, { method: "POST", headers: { "Idempotency-Key": key! } });
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(key);
});
