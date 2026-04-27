// Cover the `start()` production-wiring branch of
// docs/extensions/examples/ask-user/index.ts. Lives in its own file
// because the SDK module mock would otherwise interfere with the unit
// tests in `index.test.ts` that use the real
// `_setRegisterEventHandlerForTests` helper. Bun's per-file test
// process isolation (scripts/test.sh) keeps the mock scoped here.
//
// Pattern mirrors openai-image-gen-2/index.test.ts's `start` test.

import { describe, expect, test, mock } from "bun:test";

mock.module("@ezcorp/sdk/runtime", () => ({
  toolResult: (t: string, opts?: { isError?: boolean }) => ({
    content: [{ type: "text", text: t }],
    isError: opts?.isError === true,
  }),
  getChannel: () => ({ start: () => {}, onRequest: () => {} }),
  createToolDispatcher: () => {},
  // Phase C: ask-user's start() now calls `createCanvas` instead of
  // `registerEventHandler`. The fake mirrors the SDK's return shape
  // (an empty object) so start()'s sync flow completes.
  createCanvas: (_opts: unknown) => ({}),
  // Legacy export still imported by the production module's
  // `_setRegisterEventHandlerForTests` deprecation alias.
  registerEventHandler: () => {},
}));

import { start } from "./index";

describe("ask-user start()", () => {
  test("wires dispatcher + subscription without throwing", () => {
    expect(() => start()).not.toThrow();
  });
});
