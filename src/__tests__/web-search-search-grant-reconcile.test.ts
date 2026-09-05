import { describe, expect, test } from "bun:test";
import { handlePiSearch } from "../extensions/search-handler";
import type { JsonRpcRequest } from "../extensions/types";

describe("search-handler — the `search` grant is what gates ctx.search", () => {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/search",
    params: { action: "web", query: "latest food trends 2025", maxResults: 5 },
  };
  // Host-stamped provenance meta (mirrors tool-executor's `_meta`).
  const rpcMeta = { ezOnBehalfOf: "user-1", ezConversationId: "conv-1" };

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
