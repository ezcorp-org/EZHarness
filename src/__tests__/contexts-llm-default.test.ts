/**
 * Isolated test for the DEFAULT pi-lane completer in `src/contexts/llm.ts`.
 *
 * The main contexts-llm suite injects `completeFn`, so the default path
 * (dynamic-import `completeLLM`) is never exercised there. This tiny file
 * stubs `../providers/llm` and drives `runContextsCompletion` with no deps so
 * the default completer's import + delegation are covered. Kept separate +
 * small so the `mock.module` never leaks into the injected-deps suite.
 */
import { test, expect, mock } from "bun:test";

mock.module("../providers/llm", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completeLLM: async (_piModel: any, _ctx: any, opts: any) => ({
    stopReason: "stop",
    content: `default:${opts?.conversationId ?? "none"}`,
  }),
}));

const { runContextsCompletion } = await import("../contexts/llm");

test("default pi completer delegates to providers/llm completeLLM", async () => {
  const out = await runContextsCompletion({
    target: { kind: "pi", provider: "anthropic", modelId: "claude", piModel: {} },
    systemPrompt: "s",
    userPrompt: "u",
    conversationId: "c1",
  });
  expect(out).toBe("default:c1");
});
