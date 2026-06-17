// search.test.ts — 100% coverage for runtime/search.ts
//
// `Search` is a typed client over the `ezcorp/search` reverse RPC. We
// spy `getChannel().request` (mirroring memory.test.ts) to assert the
// per-action wire shape and to feed synthetic results / errors. The
// notable branches are the soft-fail code mappings: -32101 →
// SearchDisabledError, -32105 → SearchError, anything else rethrown.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Search, SearchDisabledError, SearchError } from "../src/runtime/search";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: Record<string, unknown>;
}

function stubRequest(impl: (call: RequestCall) => Promise<unknown>): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation((async (method: string, params: unknown) => {
    const call: RequestCall = { method, params: (params ?? {}) as Record<string, unknown> };
    calls.push(call);
    return impl(call);
  }) as HostChannel["request"]);
  return { calls };
}

describe("Search.web", () => {
  test("sends { action:'web', query } and returns the result", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "- [a](https://a)", provider: "duckduckgo", cached: false }));
    const result = await new Search().web("bun");
    expect(calls[0]?.method).toBe("ezcorp/search");
    expect(calls[0]?.params).toEqual({ action: "web", query: "bun" });
    expect(result).toEqual({ markdown: "- [a](https://a)", provider: "duckduckgo", cached: false });
  });

  test("attaches maxResults when supplied", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "", provider: "searxng", cached: false }));
    await new Search().web("bun", { maxResults: 10 });
    expect(calls[0]?.params).toEqual({ action: "web", query: "bun", maxResults: 10 });
  });

  test("omits maxResults when not supplied", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "", provider: "searxng", cached: false }));
    await new Search().web("bun", {});
    expect(calls[0]?.params).toEqual({ action: "web", query: "bun" });
  });

  test("-32101 → SearchDisabledError", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32101, "search disabled for this extension");
    });
    await expect(new Search().web("bun")).rejects.toBeInstanceOf(SearchDisabledError);
  });

  test("-32105 → SearchError", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32105, "Search failed via tavily: Tavily HTTP 401");
    });
    const err = await new Search().web("bun").catch((e) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).message).toContain("Tavily HTTP 401");
  });

  test("rethrows an unmapped JsonRpcError verbatim", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32000, "boom");
    });
    await expect(new Search().web("bun")).rejects.toThrow(/boom/);
  });

  test("rethrows a non-JsonRpcError verbatim", async () => {
    stubRequest(async () => {
      throw new Error("network down");
    });
    await expect(new Search().web("bun")).rejects.toThrow(/network down/);
  });
});

describe("Search.read", () => {
  test("sends { action:'read', url } and returns the result", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "# Page", provider: "jina", cached: true }));
    const result = await new Search().read("https://example.com");
    expect(calls[0]?.params).toEqual({ action: "read", url: "https://example.com" });
    expect(result).toEqual({ markdown: "# Page", provider: "jina", cached: true });
  });

  test("attaches maxChars when supplied", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "", provider: "jina", cached: false }));
    await new Search().read("https://x", { maxChars: 5000 });
    expect(calls[0]?.params).toEqual({ action: "read", url: "https://x", maxChars: 5000 });
  });

  test("omits maxChars when not supplied", async () => {
    const { calls } = stubRequest(async () => ({ markdown: "", provider: "jina", cached: false }));
    await new Search().read("https://x");
    expect(calls[0]?.params).toEqual({ action: "read", url: "https://x" });
  });

  test("-32101 → SearchDisabledError", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32101, "disabled");
    });
    await expect(new Search().read("https://x")).rejects.toBeInstanceOf(SearchDisabledError);
  });

  test("-32105 → SearchError", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32105, "Read failed via jina: Jina HTTP 404");
    });
    await expect(new Search().read("https://x")).rejects.toBeInstanceOf(SearchError);
  });

  test("rethrows an unmapped error", async () => {
    stubRequest(async () => {
      throw new Error("nope");
    });
    await expect(new Search().read("https://x")).rejects.toThrow(/nope/);
  });
});

describe("error classes", () => {
  test("SearchDisabledError has a stable code + default message", () => {
    const e = new SearchDisabledError();
    expect(e.code).toBe("SEARCH_DISABLED");
    expect(e.name).toBe("SearchDisabledError");
    expect(e.message).toMatch(/disabled/i);
  });

  test("SearchError carries the message + code", () => {
    const e = new SearchError("boom");
    expect(e.code).toBe("SEARCH_FAILED");
    expect(e.name).toBe("SearchError");
    expect(e.message).toBe("boom");
  });
});
