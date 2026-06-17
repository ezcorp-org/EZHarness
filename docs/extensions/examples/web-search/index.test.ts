/**
 * Unit tests for the web-search SHIM (shared-search Phase 1).
 *
 * The extension no longer owns providers — its two tools forward to the
 * host `ctx.search` capability. We mock `@ezcorp/sdk/runtime` so `Search`
 * is a stub, then assert each handler:
 *   - validates its args,
 *   - forwards query/url + clamped opts to ctx.search.{web,read},
 *   - returns the host markdown as a toolResult,
 *   - maps SearchDisabledError + generic errors to toolError.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";

afterAll(() => {
  restoreModuleMocks();
});

// ── Stub @ezcorp/sdk/runtime BEFORE importing index.ts ──────────────

interface WebCall {
  query: string;
  opts?: { maxResults?: number };
}
interface ReadCall {
  url: string;
  opts?: { maxChars?: number };
}
const webCalls: WebCall[] = [];
const readCalls: ReadCall[] = [];
let nextWeb: () => Promise<{ markdown: string; provider: string; cached: boolean }> = async () => ({
  markdown: "- [r](https://r)",
  provider: "duckduckgo",
  cached: false,
});
let nextRead: () => Promise<{ markdown: string; provider: string; cached: boolean }> = async () => ({
  markdown: "# page",
  provider: "jina",
  cached: false,
});

class StubSearchDisabledError extends Error {
  constructor(m?: string) {
    super(m);
    this.name = "SearchDisabledError";
  }
}

class StubSearch {
  async web(query: string, opts?: { maxResults?: number }) {
    webCalls.push({ query, opts });
    return nextWeb();
  }
  async read(url: string, opts?: { maxChars?: number }) {
    readCalls.push({ url, opts });
    return nextRead();
  }
}

mock.module("@ezcorp/sdk/runtime", () => ({
  toolResult: (text: string) => ({ content: [{ type: "text", text }], isError: false }),
  toolError: (message: string) => ({ content: [{ type: "text", text: message }], isError: true }),
  Search: StubSearch,
  SearchDisabledError: StubSearchDisabledError,
  getChannel: () => ({ start: () => {} }),
  createToolDispatcher: () => {},
}));

import { buildHandlers, createDeps, makeReadHandler, makeSearchHandler } from "./index";
import type { ToolCallResult } from "../../../../packages/@ezcorp/sdk/src/types";

function textOf(r: ToolCallResult): string {
  const first = r.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

beforeEach(() => {
  webCalls.length = 0;
  readCalls.length = 0;
  nextWeb = async () => ({ markdown: "- [r](https://r)", provider: "duckduckgo", cached: false });
  nextRead = async () => ({ markdown: "# page", provider: "jina", cached: false });
});

const deps = () => createDeps();

describe("search-web", () => {
  test("forwards the query and returns host markdown", async () => {
    const handler = makeSearchHandler(deps());
    const res = (await handler({ query: "bun runtime" })) as ToolCallResult;
    expect(res.isError).toBe(false);
    expect(textOf(res)).toBe("- [r](https://r)");
    expect(webCalls[0]!.query).toBe("bun runtime");
    expect(webCalls[0]!.opts).toBeUndefined(); // no maxResults → omit
  });

  test("forwards a valid maxResults", async () => {
    const handler = makeSearchHandler(deps());
    await handler({ query: "q", maxResults: 8 });
    expect(webCalls[0]!.opts).toEqual({ maxResults: 8 });
  });

  test("drops an out-of-range maxResults (omits opts → host default)", async () => {
    const handler = makeSearchHandler(deps());
    await handler({ query: "q", maxResults: 999 });
    expect(webCalls[0]!.opts).toBeUndefined();
  });

  test("rejects an empty query", async () => {
    const handler = makeSearchHandler(deps());
    const res = (await handler({ query: "   " })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/query.*required/);
    expect(webCalls).toHaveLength(0);
  });

  test("maps SearchDisabledError to a friendly toolError", async () => {
    nextWeb = async () => {
      throw new StubSearchDisabledError("disabled");
    };
    const handler = makeSearchHandler(deps());
    const res = (await handler({ query: "q" })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/disabled for this extension/);
  });

  test("maps a generic error to a toolError", async () => {
    nextWeb = async () => {
      throw new Error("Search failed via tavily: Tavily HTTP 401");
    };
    const handler = makeSearchHandler(deps());
    const res = (await handler({ query: "q" })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Tavily HTTP 401/);
  });
});

describe("read-url", () => {
  test("forwards the url and returns host markdown", async () => {
    const handler = makeReadHandler(deps());
    const res = (await handler({ url: "https://example.com" })) as ToolCallResult;
    expect(res.isError).toBe(false);
    expect(textOf(res)).toBe("# page");
    expect(readCalls[0]!.url).toBe("https://example.com");
    expect(readCalls[0]!.opts).toBeUndefined();
  });

  test("forwards a valid maxChars", async () => {
    const handler = makeReadHandler(deps());
    await handler({ url: "https://x", maxChars: 5000 });
    expect(readCalls[0]!.opts).toEqual({ maxChars: 5000 });
  });

  test("drops an out-of-range maxChars", async () => {
    const handler = makeReadHandler(deps());
    await handler({ url: "https://x", maxChars: 10 }); // below the 500 floor
    expect(readCalls[0]!.opts).toBeUndefined();
  });

  test("rejects an empty url", async () => {
    const handler = makeReadHandler(deps());
    const res = (await handler({ url: "" })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/url.*required/);
    expect(readCalls).toHaveLength(0);
  });

  test("maps SearchDisabledError to a friendly toolError", async () => {
    nextRead = async () => {
      throw new StubSearchDisabledError("disabled");
    };
    const handler = makeReadHandler(deps());
    const res = (await handler({ url: "https://x" })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/disabled for this extension/);
  });

  test("maps a generic error to a toolError", async () => {
    nextRead = async () => {
      throw new Error("Read failed via jina: Jina HTTP 404");
    };
    const handler = makeReadHandler(deps());
    const res = (await handler({ url: "https://x" })) as ToolCallResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Jina HTTP 404/);
  });
});

describe("buildHandlers / createDeps", () => {
  test("buildHandlers exposes both tools", () => {
    const handlers = buildHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["read-url", "search-web"]);
  });

  test("createDeps accepts a Search override", () => {
    const custom = new StubSearch();
    const d = createDeps({ search: custom as never });
    expect(d.search).toBe(custom);
  });

  test("createDeps defaults to a fresh Search instance", () => {
    expect(createDeps().search).toBeInstanceOf(StubSearch);
  });
});
