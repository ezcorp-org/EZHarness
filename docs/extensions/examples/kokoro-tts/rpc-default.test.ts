// Coverage for the kokoro-tts reverse-RPC default-delegation seam.
//
// The main suite (index.test.ts) always injects a fake via
// `_setRpcRequestForTests`, so the REAL default —
//   `rpcRequestImpl = (method, params) => getChannel().request(method, params)`
// — never executes there. This isolated file mocks the SDK's
// `getChannel()` so the un-injected default can run and delegate to a
// stub channel, covering that line without opening a real reverse-RPC
// (which would hang waiting on a host response).
//
// Lives in its own file because `mock.module("@ezcorp/sdk/runtime", …)`
// is process-wide and must not bleed into the main suite's real channel.

import { test, expect, describe, afterAll, mock } from "bun:test";

const requestCalls: Array<{ method: string; params: unknown }> = [];

mock.module("@ezcorp/sdk/runtime", () => ({
  // The default seam delegates to getChannel().request — stub it so the
  // delegation runs and resolves instantly.
  getChannel: () => ({
    request: async (method: string, params: unknown) => {
      requestCalls.push({ method, params });
      return {};
    },
    start: () => {},
    onRequest: () => {},
  }),
  // kokoro/index.ts also imports these from the runtime barrel; provide
  // inert stubs so module-eval succeeds.
  createCanvas: () => ({}),
  createToolDispatcher: () => {},
}));

// Import WITHOUT touching `_setRpcRequestForTests` / `_resetRpcRequestForTests`
// so the ORIGINAL module-init default seam (line 72) is the one exercised.
const { _internals } = await import("./index");

afterAll(() => {
  mock.restore();
});

describe("kokoro-tts reverse-RPC default delegation", () => {
  test("the un-injected default rpcRequest forwards to getChannel().request", async () => {
    requestCalls.length = 0;

    await _internals.handleSpeak({
      messageId: "msg-default",
      conversationId: "conv-default",
      content: "speak via the real default seam",
    });

    // The default delegated to the mocked channel.request — proving the
    // `getChannel().request(...)` arrow body executed.
    expect(requestCalls.length).toBeGreaterThan(0);
    expect(requestCalls[0]!.method).toBe("ezcorp/append-message");
  });
});
