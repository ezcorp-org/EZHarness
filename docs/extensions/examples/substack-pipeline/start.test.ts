// ── start() + tool-wrapper wiring (channel-free) ────────────────
//
// `start()` (index.ts) is the dispatcher entrypoint extracted out of the
// `import.meta.main` guard precisely so it can be exercised WITHOUT
// opening stdin. The three exported tool entries are thin wrappers that
// forward to `./lib/pipeline`; index.test.ts drives the lib functions
// directly, so this file covers the index.ts wrappers + the wiring branch.
//
// We `mock.module("@ezcorp/sdk/runtime", …)` BEFORE importing `start` so
// `getChannel`/`createToolDispatcher` are inert spies — no stdin, no real
// channel. Every OTHER runtime export stays real. `restoreModuleMocks`
// in `afterAll` hands the real channel back to sibling test files.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";
import * as realRuntime from "@ezcorp/sdk/runtime";
import { _setStoreForTests } from "./lib/scratch";

afterAll(() => {
  restoreModuleMocks();
  _setStoreForTests(null);
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

describe("substack-pipeline start() — production wiring", () => {
  test("wires the dispatcher with the exported tools, then starts the channel", async () => {
    const { start, tools } = await import("./index");

    start();

    expect(getChannelSpy).toHaveBeenCalledTimes(1);
    expect(createToolDispatcherSpy).toHaveBeenCalledTimes(1);
    expect(dispatcherToolsArg).toBe(tools);
    expect(channelStarted).toBe(1);
  });

  test("each tool entry forwards to its pipeline function", async () => {
    const { tools } = await import("./index");
    // In-memory store so the wrappers can resolve cleanly (no scratch →
    // a tool error, never a throw). We only need the wrapper bodies to run.
    const map = new Map<string, unknown>();
    _setStoreForTests({
      get: async <T>(k: string) => {
        const has = map.has(k);
        return { value: (has ? (map.get(k) as T) : null), exists: has };
      },
      set: async (k: string, v: unknown) => {
        map.set(k, v);
        return { ok: true as const, sizeBytes: 0 };
      },
      delete: async (k: string) => {
        const had = map.has(k);
        map.delete(k);
        return { deleted: had };
      },
    });

    // draft rejects a bad url before any invoke; revise/finalize report a
    // missing scratch — all tool errors, exercising the wrapper bodies.
    const draft = await tools.draft_substack_post!({ url: "ftp://nope" });
    const revise = await tools.revise_substack_post!({ feedback: "x" });
    const finalize = await tools.finalize_substack_post!({});

    expect(draft.isError).toBe(true);
    expect(revise.isError).toBe(true);
    expect(finalize.isError).toBe(true);
  });
});
