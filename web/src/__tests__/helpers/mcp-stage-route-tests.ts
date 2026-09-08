import { afterEach, beforeEach, expect, vi } from "vitest";
import { makeRequestEvent } from "./server-route-test-utils";

const mocks = vi.hoisted(() => ({
  mcpStage: vi.fn(),
  legacy: {
    installMcpExtension: vi.fn(), updateMcpExtension: vi.fn(), getExtension: vi.fn(),
    rehydrateMcpServerSecrets: vi.fn(), reload: vi.fn(), refreshMcpTools: vi.fn(), connect: vi.fn(),
  },
}));
const legacy = mocks.legacy;
export const mcpStage = mocks.mcpStage;
vi.mock("$server/extensions/mcp-control", () => ({ stageMcpExtension: mocks.mcpStage, restageMcpExtension: mocks.mcpStage }));
vi.mock("$server/db/queries/extensions", () => mocks.legacy);
vi.mock("$server/extensions/registry", () => ({ ExtensionRegistry: { getInstance: () => mocks.legacy } }));
vi.mock("$server/mcp/client", () => ({ McpClient: class { connect = mocks.legacy.connect; } }));

export type McpStageKind = "install" | "update" | "refresh";
type Handler = (event: any) => Response | Promise<Response>;
export const admin = { user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin", status: "active" }, authMethod: "session" };
export const actor = { principalId: "admin-1", scope: "global", kind: "human" };
export const candidate = { installationId: "installation", workspaceId: "candidate", revision: 1, operationId: "build", openUrl: "/extensions/author/candidate" };
export const server = { transport: "http", name: "remote", url: "https://example.com/mcp" };

export function mcpRouteFixture(kind: McpStageKind, handler: Handler) {
  const validBody = () => kind === "install" ? { name: "remote", server } : { server };
  const call = (options: { locals?: Record<string, unknown>; body?: unknown; raw?: string; id?: string | null } = {}) => handler(makeRequestEvent("http://localhost/api/mcp-servers/installation", {
    locals: options.locals ?? admin, params: { id: options.id === null ? undefined : options.id ?? "installation" },
    request: { method: kind === "update" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: options.raw ?? JSON.stringify(options.body ?? validBody()) },
  }));
  beforeEach(() => { vi.clearAllMocks(); mcpStage.mockReset(); mcpStage.mockResolvedValue(candidate); });
  afterEach(() => { for (const spy of Object.values(legacy)) expect(spy).not.toHaveBeenCalled(); });
  return { call, validBody };
}
