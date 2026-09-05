import { afterEach, expect, test, vi } from "vitest";
import { updateMcpServer } from "../lib/api";

afterEach(() => { vi.unstubAllGlobals(); });
test.each([
  [{ code: "mcp_probe_failed", message: "No release was activated." }, "No release was activated."],
  [{ error: "Legacy error", message: "New error" }, "Legacy error"],
  [{}, "500 Internal Server Error"],
])("MCP staging errors keep server diagnostics and never appear successful", async (body, message) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 500, statusText: "Internal Server Error" })));
  await expect(updateMcpServer("extension", { server: { transport: "http", name: "server", url: "https://example.com/mcp" } })).rejects.toThrow(message);
});
