/**
 * E2E: the web-search SHIM through a real ExtensionProcess subprocess.
 *
 * Shared-search Phase 1 turned web-search into a thin forwarder over the
 * host `ctx.search` capability — the provider chain, SSRF guard, and
 * cache all moved host-side (src/search/). So this e2e no longer drives a
 * provider pipeline inside the subprocess; instead it verifies the FULL
 * server pipeline of the shim:
 *
 *   sandbox preload → stdin JSON-RPC framing → dispatcher →
 *   ctx.search.{web,read} → `ezcorp/search` reverse-RPC → host handler
 *
 * The host `ezcorp/search` handler is stubbed here (returning canned
 * markdown) so the test is hermetic — NO live network, NO real provider.
 * The point is to prove the subprocess correctly issues `ezcorp/search`
 * requests with the right params and surfaces the host markdown back
 * through the tool result.
 *
 * Covers:
 *   - search-web forwards { action:"web", query, maxResults? } and
 *     returns the host markdown.
 *   - read-url forwards { action:"read", url, maxChars? }.
 *   - a host -32101 (search disabled) surfaces as a friendly toolError.
 *   - a host -32105 (provider error) surfaces as a toolError.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";

import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import type { JsonRpcResponse } from "../../../../src/extensions/types";

const ENTRYPOINT = join(import.meta.dir, "index.ts");

// ── Host-side ezcorp/search stub ────────────────────────────────────

interface SearchCall {
  action: string;
  query?: string;
  url?: string;
  maxResults?: number;
  maxChars?: number;
}

let searchCalls: SearchCall[] = [];
let nextSearchResult: () => JsonRpcResponse["result"] | { error: { code: number; message: string } } = () => ({
  markdown: "- [Bun](https://bun.sh/)\n  A runtime",
  provider: "duckduckgo",
  cached: false,
});

function wireHostRpc(proc: ExtensionProcess): void {
  proc.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
    if (req.method === "ezcorp/search") {
      const params = (req.params ?? {}) as SearchCall;
      searchCalls.push(params);
      const out = nextSearchResult();
      if (out && typeof out === "object" && "error" in out) {
        return { jsonrpc: "2.0", id: req.id, error: out.error } as JsonRpcResponse;
      }
      return { jsonrpc: "2.0", id: req.id, result: out } as JsonRpcResponse;
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
  });
}

function makeEnv(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
    TMPDIR: extTmpDir,
  };
}

const procs: ExtensionProcess[] = [];

function makeProc(): ExtensionProcess {
  const extId = "web-search-shim-" + Math.random().toString(36).slice(2, 8);
  const proc = new ExtensionProcess(extId, ENTRYPOINT, makeEnv(extId), {
    persistent: false,
    networkAllowed: false, // the shim never fetches directly anymore
    callTimeoutMs: 15_000,
  });
  wireHostRpc(proc);
  procs.push(proc);
  return proc;
}

function textOf(r: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  const first = r.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected text content");
  }
  return first.text;
}

beforeEach(() => {
  searchCalls = [];
  nextSearchResult = () => ({
    markdown: "- [Bun](https://bun.sh/)\n  A runtime",
    provider: "duckduckgo",
    cached: false,
  });
});

afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
});

afterAll(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
});

describe("E2E web-search shim → ctx.search", () => {
  test("search-web forwards { action:web, query } and returns host markdown", async () => {
    const proc = makeProc();
    const r = await proc.callTool("search-web", { query: "bun release notes", maxResults: 8 });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[Bun](https://bun.sh/)");
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.action).toBe("web");
    expect(searchCalls[0]!.query).toBe("bun release notes");
    expect(searchCalls[0]!.maxResults).toBe(8);
  }, 30_000);

  test("read-url forwards { action:read, url } and returns host markdown", async () => {
    nextSearchResult = () => ({ markdown: "# Stub\n\nbody", provider: "jina", cached: false });
    const proc = makeProc();
    const r = await proc.callTool("read-url", { url: "https://example.com", maxChars: 5000 });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("# Stub");
    expect(searchCalls[0]!.action).toBe("read");
    expect(searchCalls[0]!.url).toBe("https://example.com");
    expect(searchCalls[0]!.maxChars).toBe(5000);
  }, 30_000);

  test("a host search-disabled error (-32101) surfaces as a friendly toolError", async () => {
    nextSearchResult = () => ({ error: { code: -32101, message: "search disabled for this extension" } });
    const proc = makeProc();
    const r = await proc.callTool("search-web", { query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/disabled for this extension/);
  }, 30_000);

  test("a host provider error (-32105) surfaces as a toolError", async () => {
    nextSearchResult = () => ({ error: { code: -32105, message: "Search failed via tavily: Tavily HTTP 401" } });
    const proc = makeProc();
    const r = await proc.callTool("search-web", { query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Tavily HTTP 401/);
  }, 30_000);
});
