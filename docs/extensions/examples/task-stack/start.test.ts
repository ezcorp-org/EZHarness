// ── start() — production wiring (channel-free) ──────────────────
//
// `start()` (index.ts) is the dispatcher entrypoint extracted out of the
// `import.meta.main` guard precisely so it can be exercised WITHOUT
// opening stdin. It obtains the host channel, registers the tool
// dispatcher with the exported `tools` map, and starts the channel.
//
// We `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `start` so
// `getChannel`/`createToolDispatcher` are inert spies — no stdin, no real
// channel. Every OTHER runtime export stays real (the handlers import
// `Storage`/`toolResult`/`toolError` transitively). `restoreModuleMocks`
// in `afterAll` hands the real channel back to sibling test files.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";
import * as realRuntime from "@ezcorp/sdk/runtime";

afterAll(() => {
  restoreModuleMocks();
});

let channelStarted = 0;
const fakeChannel = {
  start() {
    channelStarted++;
  },
};
const getChannelSpy = mock(() => fakeChannel);

let dispatcherToolsArg: Record<string, unknown> | null = null;
const createToolDispatcherSpy = mock((tools: Record<string, unknown>) => {
  dispatcherToolsArg = tools;
  return { tools };
});

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realRuntime,
  getChannel: getChannelSpy,
  createToolDispatcher: createToolDispatcherSpy,
}));

describe("task-stack start() — production wiring", () => {
  test("wires the dispatcher with the tool map, then starts the channel", async () => {
    // `tools` is a module-private const in index.ts (not exported, matching
    // the original surface) — so we assert on the dispatcher's captured arg.
    const { start } = await import("./index");

    start();

    expect(getChannelSpy).toHaveBeenCalledTimes(1);
    expect(createToolDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(dispatcherToolsArg).not.toBeNull();
    expect(Object.keys(dispatcherToolsArg ?? {})).toContain("add-task");
    expect(channelStarted).toBe(1);
  });
});
