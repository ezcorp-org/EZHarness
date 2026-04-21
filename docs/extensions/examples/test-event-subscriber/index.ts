#!/usr/bin/env bun
// Minimal test extension — subscribes to `task:snapshot` and buffers
// each received payload. A tool named `drain_received` returns the
// buffer as JSON so the integration test can assert round-trip
// delivery. Not bundled.

import {
  createToolDispatcher,
  getChannel,
  registerEventHandler,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const received: unknown[] = [];

registerEventHandler("task:snapshot", (payload) => {
  received.push(payload);
});

const drain: ToolHandler = async () => {
  const copy = received.slice();
  received.length = 0;
  return toolResult(JSON.stringify(copy));
};

export const tools: Record<string, ToolHandler> = {
  drain_received: drain,
};

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
