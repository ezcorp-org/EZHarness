#!/usr/bin/env bun
// Minimal test extension — exercises the Phase 2b AgentConfigs SDK
// wrapper. Used only by src/__tests__/agent-configs.integration.test.ts.

import {
  AgentConfigs,
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const configs = new AgentConfigs();

const list: ToolHandler = async () => {
  try {
    const out = await configs.list();
    return toolResult(JSON.stringify(out));
  } catch (err) {
    return toolError(`list failed: ${(err as Error).message}`);
  }
};

const resolve: ToolHandler = async (args) => {
  const a = args as { idOrName?: unknown };
  if (typeof a.idOrName !== "string") {
    return toolError("resolve_config requires string 'idOrName'");
  }
  try {
    const out = await configs.resolve(a.idOrName);
    return toolResult(JSON.stringify(out));
  } catch (err) {
    return toolError(`resolve failed: ${(err as Error).message}`);
  }
};

export const tools: Record<string, ToolHandler> = {
  list_configs: list,
  resolve_config: resolve,
};

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
