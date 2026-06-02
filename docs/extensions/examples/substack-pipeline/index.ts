#!/usr/bin/env bun
// substack-pipeline — JSON-RPC tool dispatcher.
//
// Three deterministic tools; the LLM sequences them + the human turn per
// skills/substack-pipeline/SKILL.md. Gated on `import.meta.main` so test
// imports don't open stdin (substack-pilot / ask-user pattern).

import {
  createToolDispatcher,
  getChannel,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { draftPost, revisePost, finalizePost } from "./lib/pipeline";

const draft_substack_post: ToolHandler = async (args) =>
  draftPost(args as Record<string, unknown>);

const revise_substack_post: ToolHandler = async (args) =>
  revisePost(args as Record<string, unknown>);

const finalize_substack_post: ToolHandler = async () => finalizePost();

export const tools: Record<string, ToolHandler> = {
  draft_substack_post,
  revise_substack_post,
  finalize_substack_post,
};

// Production wiring — extracted so tests can cover the wiring branch
// (the `import.meta.main` gate alone is dead under `bun test`). Mirrors
// the `start()` pattern used by substack-pilot/index.ts and
// substack-engagement/index.ts.
export function start(): void {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
