import { describe, expect, test } from "bun:test";
import { handlePiSearch } from "../extensions/search-handler";
import type { JsonRpcRequest } from "../extensions/types";

const req: JsonRpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "ezcorp/search",
  params: { action: "web", query: "latest food trends 2025", maxResults: 5 },
};
const rpcMeta = { ezOnBehalfOf: "user-1", ezConversationId: "conv-1" };

describe("search-handler — the `search` grant is what gates ctx.search", () => {

  test("Absent approved search grant → -32101 'search disabled' (the web-search symptom)", async () => {
    const resp = await handlePiSearch(
      req,
      {
        granted: { grantedAt: {} }, // exactly seedStaleWebSearch's broken grant
        registeredTool: { extensionId: "ext-stale-websearch" },
      },
      rpcMeta,
    );
    expect(resp.error?.code).toBe(-32101);
    expect(resp.error?.message).toMatch(/search disabled/i);
  });

  test("Explicit approved grant (`search: 'inherit'`) → allowed: search runs, no -32101", async () => {
    let searched = false;
    const resp = await handlePiSearch(
      req,
      {
        granted: { search: "inherit", grantedAt: { search: 1 } },
        registeredTool: { extensionId: "ext-stale-websearch" },
        // Inject the seams so the handler resolves/enforces without a DB
        // round-trip and runs over a stub instead of the live providers.
        resolvePolicy: async () => ({
          denied: false,
          quota: 100,
          maxResults: 5,
          providers: "all",
        }),
        consumeQuota: () => ({ ok: true, remaining: 99 }),
        search: async (query: string) => {
          searched = true;
          expect(query).toBe("latest food trends 2025");
          return {
            markdown: "1. Result",
            providerName: "searxng",
            cached: false,
          } as Awaited<ReturnType<typeof import("../search/index").performSearch>>;
        },
      },
      rpcMeta,
    );
    expect(searched).toBe(true);
    expect(resp.error?.code).not.toBe(-32101);
  });
});

function allowedSearchContext(overrides: Partial<Parameters<typeof handlePiSearch>[1]> = {}) {
  return {
    granted: { search: "inherit", grantedAt: { search: 1 } },
    registeredTool: { extensionId: "ext-stale-websearch" },
    resolvePolicy: async () => ({ denied: false, quota: 5, maxResults: 3, providers: "all" }),
    hydrateQuota: async () => {},
    consumeQuota: () => ({ ok: true, remaining: 4 }),
    ...overrides,
  } as Parameters<typeof handlePiSearch>[1];
}

test("an explicit policy denial never invokes the search provider", async () => {
  let called = false;
  const response = await handlePiSearch(req, allowedSearchContext({
    resolvePolicy: async () => ({ denied: true, quota: 0, maxResults: 0, providers: "all" }),
    search: (async () => { called = true; throw new Error("must not run"); }) as never,
  }), rpcMeta);
  expect(response.error?.code).toBe(-32101);
  expect(called).toBe(false);
});

test("an exhausted approved grant returns quota failure before provider use", async () => {
  let called = false;
  const response = await handlePiSearch(req, allowedSearchContext({
    consumeQuota: () => ({ ok: false, remaining: 0, retryAfterMs: 60_000 }),
    search: (async () => { called = true; throw new Error("must not run"); }) as never,
  }), rpcMeta);
  expect(response.error?.code).toBe(-32103);
  expect(called).toBe(false);
});

test("a whitespace query is rejected without provider use", async () => {
  let called = false;
  const response = await handlePiSearch({ ...req, params: { action: "web", query: "  " } }, allowedSearchContext({
    search: (async () => { called = true; throw new Error("must not run"); }) as never,
  }), rpcMeta);
  expect(response.error?.message).toBe("query required");
  expect(called).toBe(false);
});

test("an approved grant clamps requested result count to policy", async () => {
  let maxResults: number | undefined;
  const response = await handlePiSearch({ ...req, params: { action: "web", query: "bun", maxResults: 99 } }, allowedSearchContext({
    search: (async (_query: string, options: { maxResults: number }) => { maxResults = options.maxResults; return { markdown: "ok", providerName: "fixture", cached: false }; }) as never,
  }), rpcMeta);
  expect(response.error).toBeUndefined();
  expect(maxResults).toBe(3);
});

test("an approved grant keeps URL reads separate from web search", async () => {
  let receivedUrl = "";
  const response = await handlePiSearch({ ...req, params: { action: "read", url: "https://example.com" } }, allowedSearchContext({
    read: (async (url: string) => { receivedUrl = url; return { markdown: "page", providerName: "fixture", cached: false }; }) as never,
  }), rpcMeta);
  expect(response.result).toMatchObject({ markdown: "page", provider: "fixture" });
  expect(receivedUrl).toBe("https://example.com");
});

test("an unknown action does not consume a provider call", async () => {
  let called = false;
  const response = await handlePiSearch({ ...req, params: { action: "invalid" } }, allowedSearchContext({
    search: (async () => { called = true; throw new Error("must not run"); }) as never,
  }), rpcMeta);
  expect(response.error?.message).toBe("unknown-action");
  expect(called).toBe(false);
});
