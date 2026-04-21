#!/usr/bin/env bun
// scratchpad — ephemeral conversation-scoped KV store for sharing data
// between agents during orchestration.
//
// Converted from the built-in tool in src/runtime/tools/scratchpad.ts.
// Storage is conversation-scoped (not per-run) — parallel runs in the same
// conversation share the pad. Entries auto-expire after 24h of inactivity
// via the storage-handler TTL.
//
// Permission contract: requires `storage: true`. The host's storage-handler
// (src/extensions/storage-handler.ts:117) rejects all writes/reads if the
// grant is missing; the extension itself performs no access checks.

import {
  createToolDispatcher,
  getChannel,
  Storage,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

const TTL_SECONDS = 24 * 60 * 60;

// Storage backend — conversation-scoped by default. Each write lands in a
// row keyed by (extensionId, conversationId, key) in `extension_storage`.
// The conversation id is threaded through `_meta` by the host; the SDK
// reads it transparently.
//
// Exposed via a mutable binding so unit tests can swap in an in-memory
// fake without spinning up the full JSON-RPC pipe. Production code path
// is unchanged — `_setStoreForTests()` is only called from test files.
interface StoreLike {
  get(key: string): Promise<{ value: string | null; exists: boolean }>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<unknown>;
}

let store: StoreLike = new Storage("conversation");

/** Test-only: inject a fake storage backend. Do not call in production. */
export function _setStoreForTests(fake: StoreLike): void {
  store = fake;
}

/** Test-only: restore the real Storage instance after a test. */
export function _resetStoreForTests(): void {
  store = new Storage("conversation");
}

const write: ToolHandler = async (args) => {
  const { key, value } = args as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || typeof value !== "string") {
    return toolError("scratchpad_write requires string 'key' and 'value'");
  }
  try {
    await store.set(key, value, { ttlSeconds: TTL_SECONDS });
    return toolResult(`Stored key "${key}" (${value.length} chars)`);
  } catch (err) {
    return toolError(
      `Failed to write scratchpad: ${(err as Error).message}`,
    );
  }
};

const read: ToolHandler = async (args) => {
  const { key } = args as { key?: unknown };
  if (typeof key !== "string") {
    return toolError("scratchpad_read requires a string 'key'");
  }
  try {
    const result = await store.get(key);
    if (!result.exists || result.value === null) {
      return toolResult(`Key "${key}" not found in scratchpad`);
    }
    return toolResult(result.value);
  } catch (err) {
    return toolError(
      `Failed to read scratchpad: ${(err as Error).message}`,
    );
  }
};

export const tools: Record<string, ToolHandler> = {
  scratchpad_write: write,
  scratchpad_read: read,
};

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin. See todo-tracker/index.ts for the canonical pattern.
if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
