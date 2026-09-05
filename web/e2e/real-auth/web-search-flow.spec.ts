/**
 * Real-auth e2e: web search actually works, end to end.
 *
 * This is the only test in the repo that exercises the FULL search path
 * the way an agent hits it — extension enabled → tool registered →
 * `/api/tool-invoke` → reverse RPC → grant + policy + quota → provider
 * resolution → SSRF egress guard → markdown render. Every unit test in
 * `src/__tests__/search-*` mocks at least one of those seams.
 *
 * It exists because all three faults that broke web search in production
 * were invisible to the unit suites:
 *
 *   1. `web-search` sat DISABLED pending re-approval on every boot (a
 *      phantom S9 tool-list drift), so its tools registered nowhere and
 *      no agent could call them. Fresh-install tests can't see this —
 *      on first install the stored manifest IS the disk manifest.
 *   2. The SearXNG sidecar was never reached: `localhost` resolves to
 *      `::1` first, the sidecar publishes IPv4-only, and the egress guard
 *      pinned a single address — so every search silently degraded to the
 *      DuckDuckGo fallback.
 *   3. `read-url` failed on a keyless-Jina 401. The fix adds a host-side
 *      `DirectReader` fallback — the FIRST production code path that
 *      fetches an agent-supplied URL from inside our network, which is why
 *      the SSRF case below is part of this file.
 *
 * Design notes:
 *   - The backend is a LOCAL stub speaking SearXNG's JSON API, bound
 *     explicitly to `127.0.0.1` (IPv4-only, exactly like the compose
 *     sidecar's `127.0.0.1:8889:8080` publish). Zero external network, so
 *     the assertions are deterministic — but every seam we own is real.
 *   - It is wired at RUNTIME through the admin API
 *     (`POST /api/search/backend`), which also covers the persisted
 *     Settings → provider-env bridge. No Playwright config change (those
 *     files are CODEOWNERS-owned).
 *   - The stub URL deliberately uses `localhost`, NOT `127.0.0.1`, so the
 *     IPv6-first resolution path is the one under test. Reverting the
 *     egress-guard failover fails this spec.
 */
import { test, expect } from "../fixtures/hydration.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// Relative import: the package isn't a web dependency; Playwright's TS
// loader resolves the workspace source directly.
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";
import { importAndActivateBundledExtension } from "../fixtures/extension-v4";

test.describe.configure({ mode: "serial" });

const SEARXNG_SETTING_RESET = "";

/** Titles the stub returns — asserted verbatim in the rendered markdown. */
const STUB_RESULTS = [
  {
    title: "EZCorp e2e stub result one",
    url: "https://example.invalid/one",
    content: "First canned snippet from the SearXNG stub.",
  },
  {
    title: "EZCorp e2e stub result two",
    url: "https://example.invalid/two",
    content: "Second canned snippet from the SearXNG stub.",
  },
];

interface StubHandle {
  port: number;
  /** Every `/search` query string the guard actually delivered. */
  hits: string[];
  close: () => Promise<void>;
}

/**
 * A minimal SearXNG JSON-API stub. Bound to `127.0.0.1` ONLY — that
 * asymmetry (IPv4 listener, `localhost` client URL) is the point: it
 * reproduces the sidecar topology that the address-pinning bug broke.
 */
async function startSearxngStub(): Promise<StubHandle> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/search")) {
      res.writeHead(404).end();
      return;
    }
    hits.push(url.search);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ query: url.searchParams.get("q"), results: STUB_RESULTS }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe("web search — real end-to-end", () => {
  test.beforeAll(async ({ browser, request, baseURL }) => {
    test.setTimeout(300000);
    const context = await browser.newContext({ baseURL, storageState: await request.storageState() });
    try {
      await importAndActivateBundledExtension({ page: await context.newPage(), request, baseURL: baseURL!, name: "web-search" });
    } finally {
      await context.close();
    }
  });

  test("the explicitly approved web-search release is installed AND enabled", async ({ request }) => {
    const res = await request.get("/api/extensions?name=web-search");
    expect(res.status(), await res.text()).toBe(200);
    const list = (await res.json()) as Array<{ name: string; enabled: boolean }>;

    const webSearch = list.find((e) => e.name === "web-search");
    expect(webSearch, "the approved bundled web-search release must be installed").toBeDefined();
    expect(
      webSearch!.enabled,
      "web-search is DISABLED — likely stranded pending re-approval; its tools reach no agent",
    ).toBe(true);
  });

  test("search-web returns real results through the SSRF guard via `localhost`", async ({
    request,
    baseURL,
  }) => {
    const stub = await startSearxngStub();
    try {
      // Point the resolver at the stub through the ADMIN API — this also
      // covers the persisted-Settings → provider-env bridge
      // (`resolveSearchBackendEnv`), which overrides SEARXNG_BASE_URL.
      //
      // `localhost`, not `127.0.0.1`: on a dual-stack host this resolves
      // to `::1` first while the stub listens on IPv4 only. Without the
      // egress guard's multi-address failover the guard pins `[::1]`,
      // gets connection-refused, and the search silently falls back to
      // DuckDuckGo — which would fail the stub-hit assertion below.
      const cfg = await request.post("/api/search/backend", {
        data: { searxngUrl: `http://localhost:${stub.port}` },
      });
      expect(cfg.status(), await cfg.text()).toBe(200);

      const keyRes = await request.post("/api/settings/developer/api-keys", {
        data: { name: `e2e-websearch-${Date.now()}`, scopes: ["read", "extensions"] },
      });
      expect(keyRes.status(), await keyRes.text()).toBe(201);
      const { key } = (await keyRes.json()) as { key: string };

      const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-web-search" } });
      expect(seedRes.status(), await seedRes.text()).toBe(201);
      const { conversationId } = (await seedRes.json()) as { conversationId: string };

      const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: key });
      await ez.wireExtensions(conversationId, ["web-search"]);

      const out = await ez.invokeExtensionTool(conversationId, "web-search", "search-web", {
        query: "ezcorp e2e canary",
        maxResults: 2,
      });

      expect(out.success, `search-web failed: ${JSON.stringify(out)}`).toBe(true);
      const markdown = String(out.output);
      // Real provider output, rendered by src/search/markdown.ts.
      for (const r of STUB_RESULTS) {
        expect(markdown).toContain(r.title);
        expect(markdown).toContain(r.url);
      }

      // The guard actually delivered the query to the IPv4 listener —
      // i.e. it did NOT silently fall back to DuckDuckGo.
      expect(stub.hits.length).toBeGreaterThan(0);
      expect(stub.hits[0]).toContain("format=json");
      expect(decodeURIComponent(stub.hits[0]!)).toContain("ezcorp e2e canary");
    } finally {
      await request
        .post("/api/search/backend", { data: { searxngUrl: SEARXNG_SETTING_RESET } })
        .catch(() => {});
      await stub.close();
    }
  });

  test("read-url can never be turned into an SSRF against an internal host", async ({
    request,
    baseURL,
  }) => {
    // `read-url` used to be pure passthrough to Jina — the host never dialed
    // the agent's URL itself, so `mode:"read"`'s private-IP rejection had no
    // production caller. The keyless-401 fix changes that: `DirectReader`
    // now fetches the target host-side whenever Jina is unavailable, which
    // is a textbook SSRF surface (the URL comes straight from the LLM).
    //
    // This drives the FULL real path — tool invoke → reverse RPC → grant /
    // policy / quota → reader chain → egress guard — against a loopback
    // server holding a secret, and asserts the secret is unreachable AND
    // that nothing ever knocked on the door. Deterministic without any
    // external network: neither Jina (it cannot route to our loopback) nor
    // the direct reader (the guard rejects 127.0.0.1 before connect) can
    // reach the stub, so the hit count is always 0.
    const secret = `ezcorp-internal-secret-${Date.now()}`;
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? "/");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><main><h1>${secret}</h1></main></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const keyRes = await request.post("/api/settings/developer/api-keys", {
        data: { name: `e2e-readurl-ssrf-${Date.now()}`, scopes: ["read", "extensions"] },
      });
      expect(keyRes.status(), await keyRes.text()).toBe(201);
      const { key } = (await keyRes.json()) as { key: string };

      const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-read-url" } });
      expect(seedRes.status(), await seedRes.text()).toBe(201);
      const { conversationId } = (await seedRes.json()) as { conversationId: string };

      const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: key });
      await ez.wireExtensions(conversationId, ["web-search"]);

      for (const target of [
        `http://127.0.0.1:${port}/secret`,
        `http://localhost:${port}/secret`,
        `http://169.254.169.254/latest/meta-data/`,
      ]) {
        const out = await ez.invokeExtensionTool(conversationId, "web-search", "read-url", {
          url: target,
        });
        // Whatever the outcome shape, the internal page's content must
        // never appear in what the LLM gets back.
        expect(JSON.stringify(out), `read-url leaked internal content for ${target}`).not.toContain(
          secret,
        );
      }

      // The strongest assertion: the loopback server was never contacted.
      expect(hits, "the host connected to a loopback target on the LLM's behalf").toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
