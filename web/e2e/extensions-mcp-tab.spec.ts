/**
 * Phase 2 (A) — MCP filter tab + guided install confirmation.
 *
 * - The /extensions page renders a third "MCP {count}" tab.
 * - Switching to it shows only kind:"mcp" cards.
 * - A successful MCP install surfaces a "Connected · N tools found"
 *   confirmation banner (read from the returned extension's tool count).
 *
 * Mirrors the extensions-library-tabs harness: the page does an SSR load +
 * a client `loadExtensions()` on mount, both hitting the same /api/extensions
 * mock. The custom `routes` map intercepts /api/mcp-servers (POST) and
 * returns the freshly-installed extension.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

function makeExt(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "ext-1",
    name: overrides.name ?? "my-extension",
    version: overrides.version ?? "1.0.0",
    description: overrides.description ?? "A handy extension",
    enabled: overrides.enabled !== undefined ? overrides.enabled : true,
    source: overrides.source ?? "local",
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    isBundled: overrides.isBundled ?? false,
    manifest: {
      tools: [{ name: "analyze", description: "Analyze code" }],
      permissions: {},
      ...((overrides.manifest as object) ?? {}),
    },
    grantedPermissions: overrides.grantedPermissions ?? {},
    ...overrides,
  };
}

const proj = makeProject({ id: "proj-1" });

test.describe("Extensions — MCP tab", () => {
  test("renders three tabs and MCP tab shows only kind:mcp cards", async ({ page, mockApi }) => {
    const local = makeExt({ id: "local-1", name: "local-ext", isBundled: false });
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
    await mockApi({ projects: [proj], extensions: [local, mcp] });

    await page.goto("/extensions");
    await expect(page.getByText("local-ext")).toBeVisible();

    // Three tabs present.
    await expect(page.getByTestId("ext-tab-installed")).toBeVisible();
    await expect(page.getByTestId("ext-tab-builtins")).toBeVisible();
    const mcpTab = page.getByTestId("ext-tab-mcp");
    await expect(mcpTab).toBeVisible();
    await expect(mcpTab).toContainText("1");

    // Switch to MCP: only the mcp card shows.
    await mcpTab.click();
    await expect(page.getByTestId("ext-tab-panel")).toHaveAttribute("data-active-tab", "mcp");
    await expect(page.getByText("weather-mcp")).toBeVisible();
    await expect(page.getByText("local-ext")).not.toBeVisible();
  });

  test("MCP tab shows empty state when no MCP servers connected", async ({ page, mockApi }) => {
    const local = makeExt({ id: "local-1", name: "local-ext", isBundled: false });
    await mockApi({ projects: [proj], extensions: [local] });

    await page.goto("/extensions");
    await page.getByTestId("ext-tab-mcp").click();
    await expect(page.getByText("No MCP servers connected")).toBeVisible();
  });

  test("successful MCP install shows the connected tool-count confirmation", async ({
    page,
    mockApi,
  }) => {
    const installed = {
      id: "mcp-new",
      name: "db-mcp",
      version: "1.0.0",
      description: "DB tools",
      enabled: true,
      source: "mcp",
      consecutiveFailures: 0,
      isBundled: false,
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
      grantedPermissions: {},
    };
    await mockApi({
      projects: [proj],
      extensions: [],
      routes: { "/api/mcp-servers": () => installed },
    });

    await page.goto("/extensions");
    // Switch the install form to MCP.
    await page.getByRole("button", { name: "MCP Server" }).click();
    await page.getByPlaceholder("Extension name (unique)").fill("db-mcp");
    await page.getByPlaceholder("command (e.g. npx)").fill("npx");
    await page.getByPlaceholder("args (space-separated)").fill("db-mcp");
    await page.getByRole("button", { name: "Connect" }).click();

    const banner = page.getByTestId("mcp-install-confirmation");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("mcp-install-tool-count")).toHaveText("3");
    await expect(banner).toContainText("db-mcp");
  });
});
