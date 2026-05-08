/**
 * E2E: web-search through a real ExtensionProcess subprocess.
 *
 * Unlike the unit tests (which mock `@ezcorp/sdk/runtime`), this exercises
 * the full server pipeline — sandbox preload → stdin JSON-RPC framing →
 * dispatcher → fetchPermitted → real `fetch` against a localhost stub.
 *
 * Covers:
 *   - ALLOW: default (Jina) provider succeeds when EZCORP_PERMITTED_HOSTS
 *     includes the test host and JINA_*_BASE_URL point at the stub.
 *   - DENY branch 1 (empty allowlist): `fetchPermitted` throws
 *     "EZCORP_PERMITTED_HOSTS not configured" → bubbles as toolError.
 *   - DENY branch 2 (decoy allowlist): hostname-mismatch throw bubbles
 *     as toolError.
 *   - BYOK toggle: TAVILY_API_KEY + TAVILY_BASE_URL route the same query
 *     through Tavily instead of Jina.
 *   - Cache persistence: a second subprocess run against the same data
 *     dir returns results even when the upstream stub is DOWN.
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
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
import { ExtensionProcess } from "../../../../src/extensions/subprocess";

// ── Local HTTP stub ─────────────────────────────────────────────
// Serves canned responses that match each provider's real response shape.
// We identify which provider hit the server by the request path.

interface StubState {
  searchHits: number;
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

function startStub() {
  const state: StubState = { searchHits: 0, readHits: 0, tavilyHits: 0, down: false };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (state.down) return new Response("down", { status: 503 });
      const url = new URL(req.url);
      // Jina search — path is "/" with ?q=
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("q")) {
        state.searchHits++;
        return Response.json({
          data: [
            { title: "Stub Result", url: "https://example.com/a", description: "snippet" },
          ],
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
  jinaSearchBase?: string;
  jinaReaderBase?: string;
  tavilyBase?: string;
  dataDir?: string;
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
  if (o.permittedHosts !== undefined) env.EZCORP_PERMITTED_HOSTS = o.permittedHosts;
  if (o.tavilyKey) env.TAVILY_API_KEY = o.tavilyKey;
  if (o.jinaSearchBase) env.JINA_SEARCH_BASE_URL = o.jinaSearchBase;
  if (o.jinaReaderBase) env.JINA_READER_BASE_URL = o.jinaReaderBase;
  if (o.tavilyBase) env.TAVILY_BASE_URL = o.tavilyBase;
  if (o.dataDir) env.WEB_SEARCH_DATA_DIR = o.dataDir;
  return env;
}

const ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `web-search-e2e-${Date.now()}`);

function makeProc(envOverrides: EnvOverrides, persistent = false): ExtensionProcess {
  const extId = "web-search-test-" + Math.random().toString(36).slice(2, 8);
  return new ExtensionProcess(extId, ENTRYPOINT, makeEnv(extId, envOverrides), {
    persistent,
    networkAllowed: true, // disarms preload's fetch denier so fetchPermitted's own guard fires
    callTimeoutMs: 15_000,
  });
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
  stub.state.searchHits = 0;
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

describe("E2E web-search (ALLOW: granted hostname, default Jina)", () => {
  test("search-web returns markdown when Jina stub is reachable", async () => {
    const dataDir = join(TEST_TMP_ROOT, "allow-search");
    const proc = makeProc({
      permittedHosts: stub.host,
      jinaSearchBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[Stub Result](https://example.com/a)");
    expect(stub.state.searchHits).toBe(1);
  }, 30_000);

  test("read-url returns markdown body when Jina Reader stub is reachable", async () => {
    const dataDir = join(TEST_TMP_ROOT, "allow-read");
    const proc = makeProc({
      permittedHosts: stub.host,
      jinaSearchBase: stub.url,
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

// ── DENY branches ───────────────────────────────────────────────

describe("E2E web-search (DENY: fetchPermitted guard)", () => {
  test("empty allowlist → 'not configured' toolError surfaces", async () => {
    // permittedHosts OMITTED — fetchPermitted branch 1 (readAllowlist() empty)
    const proc = makeProc({
      jinaSearchBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "deny-empty"),
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Search failed via jina");
    // Phase 2: enforcement moved to the sandbox-preload's fetch wrapper.
    // The wrapper denies with "not in the granted network allowlist"
    // (per-host check) or "blocked — extension requires 'network'
    // permission" (no network granted at all). Either pattern proves
    // the deny path fired.
    expect(textOf(r)).toMatch(
      /not in (EZCORP_PERMITTED_HOSTS|the granted network) allowlist|blocked .* requires 'network' permission/,
    );
  }, 30_000);

  test("decoy allowlist → hostname-mismatch toolError surfaces", async () => {
    const proc = makeProc({
      permittedHosts: "api.example.com", // does NOT include the stub host
      jinaSearchBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir: join(TEST_TMP_ROOT, "deny-decoy"),
    });
    procs.push(proc);

    const r = await proc.callTool("read-url", { url: "https://example.com" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Read failed via jina");
    expect(textOf(r)).toContain("not in EZCORP_PERMITTED_HOSTS allowlist");
  }, 30_000);

  test("invalid tool name returns 'Tool not found' JSON-RPC error and subprocess survives", async () => {
    const proc = makeProc({
      permittedHosts: stub.host,
      jinaSearchBase: stub.url,
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
  test("sets TAVILY_API_KEY → search hits Tavily stub, not Jina", async () => {
    const dataDir = join(TEST_TMP_ROOT, "byok");
    const proc = makeProc({
      permittedHosts: stub.host,
      tavilyKey: "tav-k",
      tavilyBase: stub.url,
      jinaSearchBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    });
    procs.push(proc);

    const r = await proc.callTool("search-web", { query: "bun release notes" });
    expect(r.isError).toBe(false);
    expect(textOf(r)).toContain("[Tavily Result](https://example.com/t)");
    expect(stub.state.tavilyHits).toBe(1);
    expect(stub.state.searchHits).toBe(0);
  }, 30_000);
});

// ── Cache persistence across subprocesses ──────────────────────

describe("E2E web-search (cache persistence across subprocess runs)", () => {
  test("second subprocess returns cached result even when upstream is DOWN", async () => {
    const dataDir = join(TEST_TMP_ROOT, "cache-persist");
    const envA: EnvOverrides = {
      permittedHosts: stub.host,
      jinaSearchBase: stub.url,
      jinaReaderBase: stub.url,
      dataDir,
    };

    // Run 1: populates cache.
    const proc1 = makeProc(envA);
    procs.push(proc1);
    const r1 = await proc1.callTool("search-web", { query: "bun release notes" });
    expect(r1.isError).toBe(false);
    expect(stub.state.searchHits).toBe(1);
    proc1.kill();

    // Run 2: same dataDir, stub flipped DOWN. Cache hit avoids outbound fetch.
    stub.state.down = true;
    const proc2 = makeProc(envA);
    procs.push(proc2);
    const r2 = await proc2.callTool("search-web", { query: "bun release notes" });
    expect(r2.isError).toBe(false);
    expect(textOf(r2)).toContain("[Stub Result](https://example.com/a)");
    expect(stub.state.searchHits).toBe(1); // unchanged — no outbound call
  }, 30_000);
});
