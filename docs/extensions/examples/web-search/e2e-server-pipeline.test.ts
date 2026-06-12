/**
 * E2E: web-search through a real ExtensionProcess subprocess.
 *
 * Unlike the unit tests (which mock `@ezcorp/sdk/runtime`), this exercises
 * the full server pipeline — sandbox preload → stdin JSON-RPC framing →
 * dispatcher → fetchPermitted → real `fetch` against a localhost stub.
 *
 * Covers:
 *   - ALLOW: default (DuckDuckGo) provider succeeds when
 *     EZCORP_PERMITTED_HOSTS includes the test host and DDG_LITE_BASE_URL
 *     points at the stub (serving the REAL captured lite fixture).
 *   - SearXNG: SEARXNG_BASE_URL routes the query through the SearXNG
 *     stub (JSON API) instead of DuckDuckGo.
 *   - Fallback: SEARXNG_BASE_URL at a dead port → connection refused →
 *     one-shot DuckDuckGo fallback still returns results.
 *   - DENY branch 1 (empty internal grant): host PDP returns
 *     "Network denied" → bubbles as toolError.
 *   - DENY branch 2 (decoy grant): hostname-mismatch deny bubbles
 *     as toolError.
 *   - BYOK toggle: TAVILY_API_KEY + TAVILY_BASE_URL route the same query
 *     through Tavily instead of DuckDuckGo.
 *   - Cache persistence: a second subprocess run against the same data
 *     dir returns results even when the upstream stub is DOWN.
 *
 * No live network: every test points the providers at the localhost stub
 * via *_BASE_URL overrides (and the manifest has no smokeTest), so nothing
 * here ever reaches duckduckgo.com or a real SearXNG.
 *
 * Rate-limit coverage lives in the unit tests (rate-limit.test.ts +
 * index.test.ts) — driving 60+ calls through a subprocess would inflate
 * runtime without adding signal.
 *
 * Isolated into its own file because `mock.module("../../../../src/db/queries/extensions")`
 * contaminates the shared module cache (matches the pattern in
 * docs/extensions/examples/github-stats/e2e-server-pipeline.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

// ── DB stubs ────────────────────────────────────────────────────
let incrementCalls = 0;
let resetCalls = 0;
let disableCalls = 0;
let simulatedConsecutiveFailures = 0;

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => {
    incrementCalls++;
    simulatedConsecutiveFailures++;
    return simulatedConsecutiveFailures;
  },
  resetFailures: async () => {
    resetCalls++;
    simulatedConsecutiveFailures = 0;
  },
  disableExtension: async () => {
    disableCalls++;
  },
}));

// Import AFTER mock.module so subprocess.ts resolves to the stub.
import { handleNetworkInternalRpc } from "../../../../src/extensions/network-handler";
import type { PermissionEngine } from "../../../../src/extensions/permission-engine";
import type { ExtensionRegistry } from "../../../../src/extensions/registry";
import { ExtensionProcess } from "../../../../src/extensions/subprocess";
import type { JsonRpcResponse } from "../../../../src/extensions/types";

// ── Local HTTP stub ─────────────────────────────────────────────
// Serves canned responses that match each provider's real response shape.
// We identify which provider hit the server by the request path.

interface StubState {
  ddgHits: number;
  searxngHits: number;
  readHits: number;
  tavilyHits: number;
  down: boolean;
}

let stub: {
  server: ReturnType<typeof Bun.serve>;
  state: StubState;
  url: string;
  host: string;
};

// REAL captured lite.duckduckgo.com page (sanitized) — same fixture the
// unit tests parse; here it's served over HTTP through the full sandbox
// pipeline. Top result: "Bun — A fast all-in-one JavaScript runtime"
// wrapped in a `uddg=` redirect that the provider must unwrap.
const DDG_LITE_FIXTURE = await Bun.file(
  join(import.meta.dir, "testdata", "ddg-lite.html"),
).text();

function startStub() {
  const state: StubState = { ddgHits: 0, searxngHits: 0, readHits: 0, tavilyHits: 0, down: false };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (state.down) return new Response("down", { status: 503 });
      const url = new URL(req.url);
      // DuckDuckGo lite — GET /lite/ with ?q=  (MUST precede the reader
      // catch-all, which matches any pathname longer than "/").
      if (req.method === "GET" && url.pathname === "/lite/" && url.searchParams.has("q")) {
        state.ddgHits++;
        return new Response(DDG_LITE_FIXTURE, { headers: { "content-type": "text/html" } });
      }
      // SearXNG — GET /search with ?format=json (also before the catch-all).
      if (req.method === "GET" && url.pathname === "/search" && url.searchParams.get("format") === "json") {
        state.searxngHits++;
        return Response.json({
          results: [{ title: "SearXNG Result", url: "https://example.com/sx", content: "sxsnip" }],
        });
      }
      // Jina reader — path is "/<target-url>"
      if (req.method === "GET" && url.pathname.length > 1) {
        state.readHits++;
        return new Response("# Stub\n\nbody", { headers: { "content-type": "text/markdown" } });
      }
      // Tavily — POST /search
      if (req.method === "POST" && url.pathname === "/search") {
        state.tavilyHits++;
        return Response.json({
          results: [{ title: "Tavily Result", url: "https://example.com/t", content: "tsnip" }],
        });
      }
      return new Response("bad route", { status: 404 });
    },
  });
  const addr = server.url;
  const host = addr.hostname; // "localhost" or "127.0.0.1"
  return { server, state, url: addr.toString().replace(/\/$/, ""), host };
}

// ── buildAllowedEnv parity (test-local) ─────────────────────────
// Mirrors `src/extensions/registry.ts buildAllowedEnv()`. We hand-roll the
// EZCORP_PERMITTED_HOSTS value and the *_API_KEY / *_BASE_URL env vars so
// each test can dial in its own sandbox state.

interface EnvOverrides {
  permittedHosts?: string;
  tavilyKey?: string;
  ddgLiteBase?: string;
  ddgHtmlBase?: string;
  searxngBase?: string;
  jinaReaderBase?: string;
  tavilyBase?: string;
  dataDir?: string;
  /**
   * Hostnames the host-side internal-network PDP allows for this proc.
   * The stub lives on localhost — an INTERNAL host — so the sandbox
   * wrapper routes every stub fetch through the `ezcorp/network.internal`
   * reverse-RPC rather than the EZCORP_PERMITTED_HOSTS (external) lane.
   * Defaults to the manifest's internal grant {localhost, 127.0.0.1,
   * searxng}; deny-branch tests pass [] or a decoy list.
   */
  internalGrant?: string[];
}

// The web-search manifest's internal-host network grant (ezcorp.config.ts).
const MANIFEST_INTERNAL_GRANT = ["localhost", "127.0.0.1", "searxng"];

/**
 * Production wires `ezcorp/network.internal` + `ezcorp/fs.*` in
 * `ToolExecutor.ensureSubprocessRpcWired`; a bare ExtensionProcess has no
 * request handler, so every internal-host fetch (the stub IS an internal
 * host) and every cache flush would bounce with "no handler wired".
 * Mirror production:
 *   - network.internal → the REAL `handleNetworkInternalRpc` plus a stub
 *     PDP that allows exactly `grant` (the test analogue of
 *     `engine.authorize` reading the manifest's network permissions).
 *   - fs.{read,write,mkdir} → minimal direct-fs handlers confined to the
 *     OS tmpdir (where every test dataDir lives) so the DiskCache's
 *     host-mediated persistence works across subprocess runs.
 */
function wireHostRpc(proc: ExtensionProcess, grant: readonly string[]): void {
  const engine = {
    authorize: async (_ctx: unknown, needed: Array<{ kind: string; value: string }>) => {
      const hostname = needed[0]?.value ?? "";
      return grant.includes(hostname)
        ? { decision: "allow", auditId: "e2e-test" }
        : {
            decision: "deny",
            reason: `missing network grant for host '${hostname}'`,
            auditId: "e2e-test",
          };
    },
  } as unknown as PermissionEngine;
  const ok = (id: string | number | null, result: unknown): JsonRpcResponse =>
    ({ jsonrpc: "2.0", id, result }) as JsonRpcResponse;
  const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse =>
    ({ jsonrpc: "2.0", id, error: { code, message } }) as JsonRpcResponse;
  const fsPath = (req: { params?: unknown }): string => {
    const p = (req.params as { path?: unknown } | undefined)?.path;
    if (typeof p !== "string" || !p.startsWith(tmpdir())) {
      throw new Error(`e2e fs stub: path outside tmpdir: ${String(p)}`);
    }
    return p;
  };
  proc.setRequestHandler(async (req): Promise<JsonRpcResponse> => {
    if (req.method === "ezcorp/network.internal") {
      return handleNetworkInternalRpc(req, {
        extensionId: "web-search-e2e",
        conversationId: "conv-e2e",
        userId: "user-e2e",
        engine,
        registry: {} as ExtensionRegistry,
      });
    }
    try {
      if (req.method === "ezcorp/fs.mkdir") {
        const p = fsPath(req);
        mkdirSync(p, { recursive: true });
        return ok(req.id, { resolvedPath: p });
      }
      if (req.method === "ezcorp/fs.read") {
        const p = fsPath(req);
        const data = readFileSync(p);
        return ok(req.id, {
          encoding: "utf-8",
          body: data.toString("base64"),
          bytes: data.byteLength,
          resolvedPath: p,
        });
      }
      if (req.method === "ezcorp/fs.write") {
        const p = fsPath(req);
        const { content = "", encoding } = req.params as { content?: string; encoding?: string };
        const buf = encoding === "binary" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, buf);
        return ok(req.id, { bytes: buf.byteLength, resolvedPath: p });
      }
    } catch (e) {
      return fail(req.id, -32000, (e as Error).message);
    }
    return fail(req.id, -32601, "Method not found");
  });
}

function makeEnv(extensionId: string, o: EnvOverrides): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
    TMPDIR: extTmpDir,
  };
  // Filesystem grant flag — the DiskCache persists via host-mediated
  // `ezcorp/fs.*` RPCs (handled by `wireHostRpc` above); without this
  // pre-flight flag the SDK fails fast and the cache degrades to
  // in-memory only (breaking the cross-subprocess persistence test).
  env.EZCORP_FS_ALLOWED = "1";
  if (o.permittedHosts !== undefined) env.EZCORP_PERMITTED_HOSTS = o.permittedHosts;
  if (o.tavilyKey) env.TAVILY_API_KEY = o.tavilyKey;
  if (o.ddgLiteBase) env.DDG_LITE_BASE_URL = o.ddgLiteBase;
  if (o.ddgHtmlBase) env.DDG_HTML_BASE_URL = o.ddgHtmlBase;
  if (o.searxngBase) env.SEARXNG_BASE_URL = o.searxngBase;
  if (o.jinaReaderBase) env.JINA_READER_BASE_URL = o.jinaReaderBase;
  if (o.tavilyBase) env.TAVILY_BASE_URL = o.tavilyBase;
  if (o.dataDir) env.WEB_SEARCH_DATA_DIR = o.dataDir;
  return env;
}

const ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `web-search-e2e-${Date.now()}`);

function makeProc(envOverrides: EnvOverrides, persistent = false): ExtensionProcess {
  const extId = "web-search-test-" + Math.random().toString(36).slice(2, 8);
  const proc = new ExtensionProcess(extId, ENTRYPOINT, makeEnv(extId, envOverrides), {
    persistent,
    networkAllowed: true, // disarms preload's fetch denier so fetchPermitted's own guard fires
    callTimeoutMs: 15_000,
  });
  wireHostRpc(proc, envOverrides.internalGrant ?? MANIFEST_INTERNAL_GRANT);
  return proc;
}

function textOf(r: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  const first = r.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected text content");
  }
  return first.text;
}

// ── Lifecycle ───────────────────────────────────────────────────

const procs: ExtensionProcess[] = [];

beforeAll(() => {
  stub = startStub();
});

afterAll(() => {
  stub.server.stop(true);
  try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  incrementCalls = 0;
  resetCalls = 0;
  disableCalls = 0;
  simulatedConsecutiveFailures = 0;
  stub.state.ddgHits = 0;
  stub.state.searxngHits = 0;
  stub.state.readHits = 0;
  stub.state.tavilyHits = 0;
  stub.state.down = false;
});

afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill(); } catch { /* already dead */ }
  }
});

// ── ALLOW branch ────────────────────────────────────────────────

describe("E2E web-search (ALLOW: granted hostname, default DuckDuckGo)", () => {
  test("search-web returns markdown parsed from the real DDG lite fixture", async () => {
    const dataDir = join(TEST_TMP_ROOT, "allow-search");
    const proc = makeProc({
      permittedHosts: stub.host,
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    // uddg-unwrapped target URL, not a duckduckgo.com/l/ redirect:
    expect(textOf(r)).toContain("[Bun — A fast all-in-one JavaScript runtime](https://bun.sh/)");
    expect(stub.state.ddgHits).toBe(1);
  }, 30_000);

  test("read-url returns markdown body when Jina Reader stub is reachable", async () => {
    const dataDir = join(TEST_TMP_ROOT, "allow-read");
    const proc = makeProc({
      permittedHosts: stub.host,
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    });
    procs.push(proc);

    const r = await proc.callTool("read-url", { url: "https://example.com" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("# Stub");
    expect(stub.state.readHits).toBe(1);
  }, 30_000);
});

// ── SearXNG selection + connection-error fallback ───────────────

describe("E2E web-search (SearXNG via SEARXNG_BASE_URL)", () => {
  test("SEARXNG_BASE_URL routes search through the SearXNG JSON API", async () => {
    const proc = makeProc({
      permittedHosts: stub.host,
      searxngBase: stub.url,
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "searxng"),
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[SearXNG Result](https://example.com/sx)");
    expect(stub.state.searxngHits).toBe(1);
    expect(stub.state.ddgHits).toBe(0);
  }, 30_000);

  test("SearXNG unreachable (dead port) → one-shot DuckDuckGo fallback serves results", async () => {
    const proc = makeProc({
      permittedHosts: `${stub.host},127.0.0.1`,
      searxngBase: "http://127.0.0.1:9", // discard port — nothing listens here
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "searxng-fallback"),
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[Bun — A fast all-in-one JavaScript runtime](https://bun.sh/)");
    expect(stub.state.searxngHits).toBe(0);
    expect(stub.state.ddgHits).toBe(1);
  }, 30_000);
});

// ── DENY branches ───────────────────────────────────────────────

describe("E2E web-search (DENY: fetchPermitted guard)", () => {
  test("empty internal grant → 'Network denied' toolError surfaces", async () => {
    // The stub is an internal host, so enforcement is the host-side
    // `ezcorp/network.internal` PDP (network-handler.ts), not the
    // wrapper's external EZCORP_PERMITTED_HOSTS lane. An empty grant
    // models "extension installed but network permission not granted".
    const proc = makeProc({
      ddgLiteBase: stub.url,
      ddgHtmlBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "deny-empty"),
      internalGrant: [],
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Search failed via duckduckgo");
    expect(textOf(r)).toContain("Network denied");
    expect(textOf(r)).toContain("missing network grant");
  }, 30_000);

  test("decoy grant → hostname-mismatch toolError surfaces", async () => {
    const proc = makeProc({
      permittedHosts: "api.example.com",
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "deny-decoy"),
      internalGrant: ["api.example.com"], // does NOT include the stub host
    });
    procs.push(proc);

    const r = await proc.callTool("read-url", { url: "https://example.com" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Read failed via jina");
    expect(textOf(r)).toContain("Network denied");
  }, 30_000);

  test("invalid tool name returns 'Tool not found' JSON-RPC error and subprocess survives", async () => {
    const proc = makeProc({
      permittedHosts: stub.host,
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "deny-unknown"),
    }, true);
    procs.push(proc);

    const bad = await proc.callTool("does-not-exist", {});
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("Tool not found");
    // Still alive: second valid call succeeds.
    const ok = await proc.callTool("search-web", { query: "bun" });
    expect(ok.isError).toBe(false);
    expect(proc.isRunning).toBe(true);
  }, 30_000);
});

// ── BYOK toggle ─────────────────────────────────────────────────

describe("E2E web-search (BYOK: TAVILY_API_KEY switches provider)", () => {
  test("sets TAVILY_API_KEY → search hits Tavily stub, not DuckDuckGo", async () => {
    const dataDir = join(TEST_TMP_ROOT, "byok");
    const proc = makeProc({
      permittedHosts: stub.host,
      tavilyKey: "tav-k",
      tavilyBase: stub.url,
      ddgLiteBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[Tavily Result](https://example.com/t)");
    expect(stub.state.tavilyHits).toBe(1);
    expect(stub.state.ddgHits).toBe(0);
  }, 30_000);
});

// ── Cache persistence across subprocesses ──────────────────────

describe("E2E web-search (cache persistence across subprocess runs)", () => {
  test("second subprocess returns cached result even when upstream is DOWN", async () => {
    const dataDir = join(TEST_TMP_ROOT, "cache-persist");
    const envA: EnvOverrides = {
      permittedHosts: stub.host,
      ddgLiteBase: stub.url,
      ddgHtmlBase: stub.url, // in-class fallback would 503 too; cache must win first
      jinaReaderBase: stub.url,
      dataDir,
    };

    // Run 1: populates cache.
    const proc1 = makeProc(envA);
    procs.push(proc1);
    const r1 = await proc1.callTool("search-web", { query: "bun release notes" });
    expect(r1.isError).toBe(false);
    expect(stub.state.ddgHits).toBe(1);
    proc1.kill();

    // Run 2: same dataDir, stub flipped DOWN. Cache hit avoids outbound fetch.
    stub.state.down = true;
    const proc2 = makeProc(envA);
    procs.push(proc2);
    const r2 = await proc2.callTool("search-web", { query: "bun release notes" });
    expect(r2.isError).toBe(false);
    expect(textOf(r2)).toContain("[Bun — A fast all-in-one JavaScript runtime](https://bun.sh/)");
    expect(stub.state.ddgHits).toBe(1); // unchanged — no outbound call
  }, 30_000);
});
