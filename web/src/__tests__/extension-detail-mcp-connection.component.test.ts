/**
 * Phase 3 (B) — MCP Connection panel component test for the extension
 * detail page (`web/src/routes/(app)/extensions/[id]/+page.svelte`).
 *
 * Coverage-audit gap: the PUT handler + edit e2e are covered, but there
 * was NO test asserting the SECURITY-LOAD-BEARING invariant that header
 * **secret values are never rendered** — the Connection panel emits
 * header KEYS only (see the `{#each Object.keys(s.headers)}` block in the
 * page). This mounts the route page with an http-transport mcp server
 * whose `headers: { Authorization: "Bearer SUPERSECRET" }` and asserts:
 *   - Connection panel + Edit button render for `kind:"mcp"`.
 *   - The header KEY ("Authorization") shows, but the secret string
 *     "SUPERSECRET" is ABSENT from the DOM.
 *   - The panel is hidden for a `kind:"local"` extension.
 *
 * The page reads `$page.params.id` and fires several GETs in onMount
 * (`/api/extensions/[id]` + /settings, /audit, /violations,
 * /expired-grants, and /api/auth/me). We mock `$app/stores` for the id
 * and a URL-keyed fetch spy for the loaders (benign empty shapes for the
 * subroutes so the page's other panels degrade gracefully).
 */
import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { pageStore } = vi.hoisted(() => ({
  pageStore: {
    params: { id: "" } as { id: string },
    subscribe(run: (v: { params: { id: string } }) => void) {
      run({ params: pageStore.params });
      return () => {};
    },
  },
}));

vi.mock("$app/stores", () => ({ page: pageStore }));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
// The page imports `updateMcpServer` + the `McpServerSpec` type from
// $lib/api. The type is erased by the compiler; only the function needs a
// runtime stub. We never click "Test & Save" here, so it's never invoked.
vi.mock("$lib/api", () => ({ updateMcpServer: vi.fn() }));

import ExtensionDetailPage from "../routes/(app)/extensions/[id]/+page.svelte";

const SECRET = "SUPERSECRET";

/** http-transport mcp ext carrying a bearer secret in its server headers. */
function mcpExtWithSecret(id: string) {
  return {
    id,
    name: "weather-mcp",
    version: "0.1.0",
    description: "Weather tools over HTTP",
    enabled: true,
    source: "mcp:http",
    installPath: "",
    checksumVerified: false,
    consecutiveFailures: 0,
    isBundled: false,
    manifest: {
      author: "local",
      entrypoint: "",
      kind: "mcp",
      mcpServers: [
        {
          transport: "http",
          name: "weather",
          url: "https://example.com/mcp",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      ],
      tools: [{ name: "forecast", description: "Get forecast", inputSchema: {} }],
      permissions: {},
    },
    grantedPermissions: { grantedAt: {} },
    createdAt: new Date("2026-05-01T00:00:00.000Z").toISOString(),
  };
}

function localExt(id: string) {
  return {
    id,
    name: "local-ext",
    version: "1.0.0",
    description: "A local extension",
    enabled: true,
    source: "local",
    installPath: "/tmp/x",
    checksumVerified: false,
    consecutiveFailures: 0,
    isBundled: false,
    manifest: {
      author: "local",
      entrypoint: "index.ts",
      kind: "local",
      tools: [],
      permissions: {},
    },
    grantedPermissions: { grantedAt: {} },
    createdAt: new Date("2026-05-01T00:00:00.000Z").toISOString(),
  };
}

/**
 * Install a URL-keyed fetch spy. The detail GET returns `ext`; all the
 * onMount subroutes return benign empty shapes so the page's other
 * loaders settle without errors.
 */
function installFetch(id: string, ext: Record<string, unknown>) {
  const original = globalThis.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/auth/me") return json({ user: { id: "u1", role: "user" } });
    if (url === `/api/extensions/${id}`) return json(ext);
    if (url === `/api/extensions/${id}/settings`) return json({ schema: {}, userValues: {} });
    if (url === `/api/extensions/${id}/expired-grants`) return json({ grants: [] });
    if (url === `/api/extensions/${id}/audit`) return json({ entries: [] });
    if (url === `/api/extensions/${id}/violations`) return json([]);
    return json({});
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restoreFetch: () => void;

afterEach(() => {
  restoreFetch?.();
  vi.restoreAllMocks();
});

describe("Extension detail — MCP Connection panel (secret-not-rendered)", () => {
  test("renders Connection panel + Edit button for mcp; header secret value is never in the DOM", async () => {
    const id = "mcp-secret-1";
    pageStore.params.id = id;
    const ext = mcpExtWithSecret(id);
    restoreFetch = installFetch(id, ext);

    const { findByTestId, getByTestId } = render(ExtensionDetailPage);

    // Panel + Edit affordance present for kind:"mcp".
    const panel = await findByTestId("mcp-connection-panel");
    expect(panel).toBeInTheDocument();
    expect(getByTestId("mcp-edit-connection-button")).toBeInTheDocument();

    // Transport + URL render; the header KEY shows.
    expect(getByTestId("mcp-connection-transport")).toHaveTextContent("http");
    expect(getByTestId("mcp-connection-url")).toHaveTextContent("https://example.com/mcp");
    const headers = getByTestId("mcp-connection-headers");
    expect(headers).toHaveTextContent("Authorization");

    // SECURITY: the bearer secret value must never reach the DOM.
    expect(headers).not.toHaveTextContent(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  test("hides the Connection panel for a non-mcp (local) extension", async () => {
    const id = "local-1";
    pageStore.params.id = id;
    restoreFetch = installFetch(id, localExt(id));

    const { findByText, queryByTestId } = render(ExtensionDetailPage);

    // Wait for the page to load (header renders the name).
    await findByText("local-ext");
    await waitFor(() => {
      expect(queryByTestId("mcp-connection-panel")).toBeNull();
    });
  });
});
