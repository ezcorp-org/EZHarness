import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";

afterAll(() => {
  // The mock below replaces `@ezcorp/sdk/runtime` for the rest of the
  // bun-test run. Sibling tests that exercise `getChannel().request(...)`
  // (claude-design, task-stack, todo-tracker) need the real channel
  // back. The global preload's afterEach drops the channel singleton
  // but does NOT undo module mocks — this restores them.
  restoreModuleMocks();
});

// ── Mock BEFORE importing index.ts ─────────────────────────────────
// The handlers import `@ezcorp/sdk/runtime` (for toolResult/toolError and
// the dispatcher). We replace only the network primitive + keep the real
// builders by re-exporting them. Production wiring (`getChannel`,
// `createToolDispatcher`) is guarded behind `import.meta.main` so
// importing the module does not open stdin.

let nextResponse: () => Response = () => new Response("{}");
let fetchCallCount = 0;

mock.module("@ezcorp/sdk/runtime", () => {
  const real = {
    toolResult: (text: string) => ({ content: [{ type: "text", text }], isError: false }),
    toolError: (message: string) => ({ content: [{ type: "text", text: message }], isError: true }),
  };
  return {
    ...real,
    fetchPermitted: (_url: string | URL, _init?: RequestInit) => {
      fetchCallCount++;
      return Promise.resolve(nextResponse());
    },
    // Production wiring — never called from unit tests because
    // `import.meta.main` is false. Provide stubs so the module imports cleanly.
    getChannel: () => ({ start: () => {} }),
    createToolDispatcher: () => {},
  };
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallResult } from "../../../../packages/@ezcorp/sdk/src/types";
import { DiskCache } from "./cache";
import { createDeps, makeReadHandler, makeSearchHandler, buildHandlers } from "./index";
import { RateLimiter } from "./rate-limit";

function textOf(r: ToolCallResult): string {
  const first = r.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "web-search-index-"));
  fetchCallCount = 0;
  nextResponse = () => new Response("{}");
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.SERPAPI_API_KEY;
});

function makeDeps(opts?: { limit?: number }) {
  const cache = new DiskCache({ filePath: join(dir, "c.json"), maxEntries: 10 });
  const limiter = new RateLimiter({ windowMs: 60_000, now: () => 0 });
  const deps = createDeps({ cache, limiter });
  if (opts?.limit !== undefined) limiter.register("jina", opts.limit);
  return deps;
}

// ── search-web ──────────────────────────────────────────────────────

describe("search-web handler", () => {
  test("rejects missing/empty query", async () => {
    const h = makeSearchHandler(makeDeps());
    const bad1 = await h({});
    expect(bad1.isError).toBe(true);
    expect(textOf(bad1)).toContain("`query` is required");
    const bad2 = await h({ query: "   " });
    expect(bad2.isError).toBe(true);
  });

  test("happy path: cache miss → 1 fetch; second call hits cache → 0 fetches", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ title: "T", url: "https://u", description: "D" }] }));
    const h = makeSearchHandler(makeDeps());
    const r1 = await h({ query: "bun" });
    expect(r1.isError).toBe(false);
    expect(textOf(r1)).toContain("[T](https://u)");
    expect(fetchCallCount).toBe(1);
    const r2 = await h({ query: "bun" });
    expect(r2.isError).toBe(false);
    expect(fetchCallCount).toBe(1);
  });

  test("maxResults out of range → clamped to default 5 (no error)", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    const h = makeSearchHandler(makeDeps());
    const r = await h({ query: "x", maxResults: 999 });
    expect(r.isError).toBe(false);
  });

  test("rate-limit tripped returns the exact LIMIT_MSG", async () => {
    const deps = makeDeps({ limit: 0 });
    const h = makeSearchHandler(deps);
    const r = await h({ query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      "Web search free-tier limit hit. Set TAVILY_API_KEY, BRAVE_API_KEY, EXA_API_KEY, or SERPAPI_API_KEY to unlock more.",
    );
  });

  test("upstream error surfaces toolError with provider name", async () => {
    nextResponse = () => new Response("oops", { status: 502 });
    const h = makeSearchHandler(makeDeps());
    const r = await h({ query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Search failed via jina");
    expect(textOf(r)).toContain("HTTP 502");
  });

  test("BYOK env switches provider: handler uses Tavily when TAVILY_API_KEY is set", async () => {
    process.env.TAVILY_API_KEY = "tav";
    // Tavily returns `results[]`, not `data[]` — serving a Tavily-shaped body
    // confirms the handler resolved to Tavily.
    nextResponse = () => new Response(JSON.stringify({ results: [{ title: "T", url: "https://t", content: "C" }] }));
    const h = makeSearchHandler(makeDeps());
    const r = await h({ query: "bun" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[T](https://t)");
  });
});

// ── read-url ────────────────────────────────────────────────────────

describe("read-url handler", () => {
  test("rejects missing/empty url", async () => {
    const h = makeReadHandler(makeDeps());
    const bad = await h({});
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("`url` is required");
    const bad2 = await h({ url: "   " });
    expect(bad2.isError).toBe(true);
  });

  test("happy path: cache miss → 1 fetch; truncation respects maxChars", async () => {
    const body = "abcdefghij"; // 10 chars
    nextResponse = () => new Response(body, { status: 200 });
    const h = makeReadHandler(makeDeps());
    const r = await h({ url: "https://example.com", maxChars: 500 });
    expect(r.isError).toBe(false);
    // maxChars clamped to 500 (min), result is full body (10 chars).
    expect(textOf(r)).toBe(body);
  });

  test("truncation applied when content exceeds maxChars", async () => {
    const big = "x".repeat(1000);
    nextResponse = () => new Response(big, { status: 200 });
    const h = makeReadHandler(makeDeps());
    const r = await h({ url: "https://e", maxChars: 600 });
    expect(r.isError).toBe(false);
    expect(textOf(r).length).toBe(600);
  });

  test("maxChars out of range → clamped to default 20000", async () => {
    const big = "x".repeat(50000);
    nextResponse = () => new Response(big, { status: 200 });
    const h = makeReadHandler(makeDeps());
    const r = await h({ url: "https://e", maxChars: 10 /* below min=500 */ });
    expect(r.isError).toBe(false);
    expect(textOf(r).length).toBe(20000);
  });

  test("empty body → toolError via reader", async () => {
    nextResponse = () => new Response("", { status: 200 });
    const h = makeReadHandler(makeDeps());
    const r = await h({ url: "https://binary" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Read failed via jina");
    expect(textOf(r)).toMatch(/binary or unreachable/);
  });

  test("rate-limit tripped returns the exact LIMIT_MSG", async () => {
    const deps = makeDeps({ limit: 0 });
    const h = makeReadHandler(deps);
    const r = await h({ url: "https://e" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("free-tier limit hit");
  });

  test("cache hit returns truncated hit without issuing a fetch", async () => {
    nextResponse = () => new Response("x".repeat(100), { status: 200 });
    const h = makeReadHandler(makeDeps());
    await h({ url: "https://e" });
    expect(fetchCallCount).toBe(1);
    // Second call with smaller maxChars.
    const r2 = await h({ url: "https://e", maxChars: 500 });
    expect(fetchCallCount).toBe(1);
    expect(r2.isError).toBe(false);
  });
});

// ── wiring factories ────────────────────────────────────────────────

describe("buildHandlers / createDeps factory", () => {
  test("buildHandlers returns both tools", () => {
    const h = buildHandlers(makeDeps());
    expect(typeof h["search-web"]).toBe("function");
    expect(typeof h["read-url"]).toBe("function");
  });

  test("createDeps with no overrides produces a working pair", () => {
    const deps = createDeps();
    expect(deps.cache).toBeInstanceOf(DiskCache);
    expect(deps.limiter).toBeInstanceOf(RateLimiter);
    // Limiter has jina registered with a finite cap.
    expect(deps.limiter.allow("jina")).toBe(true);
  });

  test("WEB_SEARCH_DATA_DIR override reroutes cache path", () => {
    process.env.WEB_SEARCH_DATA_DIR = dir;
    try {
      const deps = createDeps();
      expect(deps.cache).toBeInstanceOf(DiskCache);
    } finally {
      delete process.env.WEB_SEARCH_DATA_DIR;
    }
  });
});

describe("start() production wiring", () => {
  test("wires dispatcher then starts the channel", async () => {
    const { start } = await import("./index");
    expect(() => start()).not.toThrow();
  });
});
