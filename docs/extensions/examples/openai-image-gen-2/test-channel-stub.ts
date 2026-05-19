// Shared channel stub for openai-image-gen-2 test files that
// `mock.module("@ezcorp/sdk/runtime", ...)`. Three of them
// (index.test.ts, codex-client.test.ts, openai-client.test.ts) replace
// the SDK exports with a custom factory to intercept `fetchPermitted`.
// Their stubs historically returned `getChannel: () => ({ start: () => {} })`,
// which broke the moment sibling tests (image-storage.test.ts,
// ext-files.test.ts) started calling `getChannel().request(...)` via
// the Phase 3 fs helpers.
//
// The stub here returns a channel whose `request` method routes
// `ezcorp/fs.exists`/`ezcorp/fs.read` to real on-disk IO under the
// test's `process.cwd()`. Any other method throws a clear error so a
// missing per-test override surfaces loud, not as a confusing
// "request is not a function" or 30s timeout.

import { existsSync, readFileSync } from "node:fs";

export const stubChannel = {
  start: () => {},
  // Sibling test files (claude-design/index.ts ships in the same
  // bun-test run when invoked from the repo root) call
  // `getChannel().onRequest(...)` via `createCanvas`. No-op the handler
  // registration so module evaluation doesn't crash; the canvas events
  // are exercised under a real channel in claude-design's own tests
  // (where `restoreModuleMocks()` has reverted this mock).
  onRequest: (_method: string, _handler: (params: unknown) => Promise<unknown> | unknown) => {},
  onNotification: (_method: string, _handler: (params: unknown) => void) => {},
  request: async (method: string, params: unknown): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.exists") {
      return { exists: existsSync(path) };
    }
    if (method === "ezcorp/fs.read") {
      if (!existsSync(path)) {
        const err = new Error(`ENOENT: no such file or directory: ${path}`) as Error & { code?: number };
        err.code = -32000;
        throw err;
      }
      const bytes = readFileSync(path);
      const body = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
      const encoding = (p.encoding as string) ?? "utf-8";
      return { encoding, body, bytes: bytes.byteLength, resolvedPath: path };
    }
    if (method === "ezcorp/fs.write" || method === "ezcorp/fs.mkdir" || method === "ezcorp/fs.list" || method === "ezcorp/fs.stat") {
      throw new Error(
        `test-channel-stub: ${method} not implemented — install a per-test spy on getChannel().request if your test needs it`,
      );
    }
    throw new Error(`test-channel-stub: unexpected RPC method ${method}`);
  },
};
