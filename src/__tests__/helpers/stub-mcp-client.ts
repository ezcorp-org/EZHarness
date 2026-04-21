import type { ToolDefinition, ToolCallResult } from "../../extensions/types";

/**
 * Shared hooks for the stub McpClient used by API/E2E tests.
 * Tests mutate these at runtime to shape per-case behavior.
 */
export const mcpStubHooks: {
  connect: () => Promise<void>;
  list: () => Promise<ToolDefinition[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  connectCalls: number;
} = {
  connect: async () => {},
  list: async () => [],
  call: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
  connectCalls: 0,
};

export function resetMcpStubHooks(): void {
  mcpStubHooks.connect = async () => {};
  mcpStubHooks.list = async () => [];
  mcpStubHooks.call = async () => ({ content: [{ type: "text", text: "ok" }], isError: false });
  mcpStubHooks.connectCalls = 0;
}

export class McpClient {
  isConnected = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_spec: unknown) {}
  async connect(): Promise<void> {
    mcpStubHooks.connectCalls++;
    await mcpStubHooks.connect();
    this.isConnected = true;
  }
  async listTools(): Promise<ToolDefinition[]> {
    return mcpStubHooks.list();
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return mcpStubHooks.call(name, args);
  }
  async close(): Promise<void> {
    this.isConnected = false;
  }
}
