/**
 * Phase 2 (A) — Extensions page MCP-tab component test
 * (`web/src/routes/(app)/extensions/+page.svelte`).
 *
 * Coverage-audit gap: the MCP filter tab + guided-install confirmation
 * were covered at the unit (library-tabs) + e2e layers only. This mounts
 * the route page with mixed-`kind` extensions and asserts the spec floor:
 *   - The page renders 3 tabs (Installed / Built-ins / MCP) with counts.
 *   - The MCP tab filters the panel to `kind:"mcp"` rows only.
 *   - A successful MCP install renders "Connected · N tools found",
 *     where N is read from the returned extension's `manifest.tools.length`.
 *
 * The page takes its first paint from the SSR `data` prop
 * (`{bundledExtensions, installedExtensions}`), then re-fetches via
 * `loadExtensions()` on mount. We feed both through a URL-keyed fetch spy.
 * `$lib/toast` is mocked to a no-op so install success/error toasts don't
 * touch a real store. localStorage is jsdom-native (library-tabs round-trip).
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("$lib/toast.svelte.js", () => ({ addToast: vi.fn() }));

import ExtensionsPage from "../routes/(app)/extensions/+page.svelte";

function makeExt(overrides: Record<string, unknown> = {}) {
  const { manifest: manifestOverride, ...rest } = overrides;
  const manifest = {
    tools: [{ name: "analyze", description: "Analyze code" }],
    permissions: {},
    ...((manifestOverride as object) ?? {}),
  };
  return {
    id: "ext-1",
    name: "my-extension",
    version: "1.0.0",
    description: "A handy extension",
    enabled: true,
    source: "local",
    consecutiveFailures: 0,
    isBundled: false,
    grantedPermissions: {},
    ...rest,
    manifest,
  };
}

const local = makeExt({ id: "local-1", name: "local-ext" });
const mcp = makeExt({
  id: "mcp-1",
  name: "weather-mcp",
  manifest: {
    kind: "mcp",
    tools: [{ name: "forecast", description: "Get forecast" }],
    permissions: {},
    mcpServers: [{ transport: "stdio", name: "weather", command: "npx", args: ["weather"] }],
  },
});

/**
 * URL-keyed fetch spy. `/api/extensions` (the on-mount reload) returns the
 * full mixed list; `/api/mcp-servers` POST returns a freshly-installed mcp
 * extension; the post-install reload returns the list plus the new server.
 */
function installFetch(opts: { list: unknown[]; afterInstall?: unknown[]; installed?: unknown }) {
  const original = globalThis.fetch;
  let installCalled = false;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/mcp-servers" && method === "POST") {
      installCalled = true;
      return json(opts.installed ?? {});
    }
    if (url === "/api/extensions") {
      return json(installCalled && opts.afterInstall ? opts.afterInstall : opts.list);
    }
    return json({});
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restoreFetch: () => void;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  restoreFetch?.();
  vi.restoreAllMocks();
});

describe("Extensions page — MCP tab + guided install", () => {
  test("renders three tabs; MCP tab filters to kind:mcp rows", async () => {
    restoreFetch = installFetch({ list: [local, mcp] });
    const { getByTestId, findByText, queryByText } = render(ExtensionsPage, {
      props: { data: { bundledExtensions: [], installedExtensions: [local, mcp] } },
    });

    // Three tabs present.
    const installedTab = getByTestId("ext-tab-installed");
    getByTestId("ext-tab-builtins");
    const mcpTab = getByTestId("ext-tab-mcp");
    // MCP count reflects the one kind:"mcp" extension.
    expect(mcpTab).toHaveTextContent("1");
    // Installed defaults active; both non-bundled cards show.
    expect(installedTab).toHaveAttribute("aria-selected", "true");
    await findByText("local-ext");
    await findByText("weather-mcp");

    // Switch to MCP → only the mcp card remains.
    await fireEvent.click(mcpTab);
    expect(getByTestId("ext-tab-panel")).toHaveAttribute("data-active-tab", "mcp");
    await findByText("weather-mcp");
    await waitFor(() => expect(queryByText("local-ext")).toBeNull());
  });

  test("successful MCP install renders 'Connected · N tools found' from manifest.tools.length", async () => {
    const installed = makeExt({
      id: "db-mcp",
      name: "db-mcp",
      source: "mcp",
      manifest: {
        kind: "mcp",
        tools: [
          { name: "query", description: "Run a query" },
          { name: "schema", description: "Inspect schema" },
          { name: "migrate", description: "Run migration" },
        ],
        permissions: {},
        mcpServers: [{ transport: "stdio", name: "db", command: "npx", args: ["db-mcp"] }],
      },
    });
    restoreFetch = installFetch({
      list: [],
      afterInstall: [installed],
      installed,
    });
    const { getByText, getByPlaceholderText, findByTestId } = render(ExtensionsPage, {
      props: { data: { bundledExtensions: [], installedExtensions: [] } },
    });

    // Switch install form to MCP, fill, connect.
    await fireEvent.click(getByText("MCP Server"));
    await fireEvent.input(getByPlaceholderText("Extension name (unique)"), {
      target: { value: "db-mcp" },
    });
    await fireEvent.input(getByPlaceholderText("command (e.g. npx)"), { target: { value: "npx" } });
    await fireEvent.input(getByPlaceholderText("args (space-separated)"), {
      target: { value: "db-mcp" },
    });
    await fireEvent.click(getByText("Connect"));

    // Confirmation banner reads the returned manifest's tool count (3).
    const banner = await findByTestId("mcp-install-confirmation");
    expect(banner).toBeInTheDocument();
    expect(await findByTestId("mcp-install-tool-count")).toHaveTextContent("3");
    expect(banner).toHaveTextContent("db-mcp");
  });
});
