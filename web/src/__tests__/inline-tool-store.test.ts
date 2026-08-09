/**
 * `inlineToolStore` — add / updateFromEvent / lookups / remove.
 *
 * Runs under VITEST, not bun, despite the plain `.test.ts` name (registered
 * explicitly in web/vitest.config.ts and subtracted from `web_bunleg_files()`
 * in scripts/lib/test-file-sets.sh — the same arrangement relative-time.test.ts
 * and send-message.test.ts use; the basename is kept so the Gate-integrity
 * test-rename check stays satisfied).
 *
 * It used to carry a rune-free `TestInlineToolStore` re-implementation and
 * assert against THAT, because bun cannot compile a `.svelte.ts` rune module.
 * A copy asserts nothing about the shipped code — and it is why
 * `inline-tool-store.svelte.ts` had no lcov data at all, which in turn is why
 * its `any`s sat on `biome.json`'s noExplicitAny opt-out list (issue #142).
 * Vitest applies the rune transform, so these tests now drive the real store.
 */
import { describe, test, expect, beforeEach } from "vitest";
import { inlineToolStore, type InlineToolCall } from "$lib/inline-tool-store.svelte";

function makeCall(
  overrides: Partial<Omit<InlineToolCall, "status" | "retryCount">> = {},
): Omit<InlineToolCall, "status" | "retryCount"> {
  return {
    id: overrides.id ?? "inv-1",
    extensionName: overrides.extensionName ?? "ext-a",
    toolName: overrides.toolName ?? "doThing",
    input: overrides.input ?? { foo: "bar" },
    conversationId: overrides.conversationId ?? "conv-1",
    messageId: overrides.messageId,
  };
}

describe("inline tool store (IEXT-02)", () => {
  beforeEach(() => {
    // Module-level singleton: reset rather than re-construct.
    inlineToolStore.calls = [];
  });

  test("add() creates call with pending status and retryCount=0", () => {
    inlineToolStore.add(makeCall());
    expect(inlineToolStore.calls).toHaveLength(1);
    expect(inlineToolStore.calls[0]!.status).toBe("pending");
    expect(inlineToolStore.calls[0]!.retryCount).toBe(0);
    expect(inlineToolStore.calls[0]!.extensionName).toBe("ext-a");
  });

  test("add() preserves existing calls", () => {
    inlineToolStore.add(makeCall({ id: "inv-1" }));
    inlineToolStore.add(makeCall({ id: "inv-2" }));
    expect(inlineToolStore.calls).toHaveLength(2);
    expect(inlineToolStore.calls[0]!.id).toBe("inv-1");
    expect(inlineToolStore.calls[1]!.id).toBe("inv-2");
  });

  test("updateFromEvent() transitions pending->running on tool:start", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", { timestamp: 1000 });
    expect(inlineToolStore.calls[0]!.status).toBe("running");
    expect(inlineToolStore.calls[0]!.startedAt).toBe(1000);
  });

  test("updateFromEvent() carries cardType and cardLayout from tool:start", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", {
      timestamp: 1,
      cardType: "diff",
      cardLayout: "dock",
    });
    expect(inlineToolStore.calls[0]!.cardType).toBe("diff");
    expect(inlineToolStore.calls[0]!.cardLayout).toBe("dock");
  });

  test("updateFromEvent() ignores a cardLayout that is neither 'dock' nor 'inline'", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", {
      timestamp: 1,
      cardLayout: "sideways",
    });
    expect(inlineToolStore.calls[0]!.cardLayout).toBeUndefined();
  });

  test("updateFromEvent() ignores an unknown event type", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:something-else", { timestamp: 1 });
    expect(inlineToolStore.calls[0]!.status).toBe("pending");
  });

  test("updateFromEvent() transitions running->complete on tool:complete", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", { timestamp: 1000 });
    inlineToolStore.updateFromEvent("inv-1", "tool:complete", {
      output: "done",
      duration: 250,
      cardType: "diff",
      cardLayout: "inline",
    });
    expect(inlineToolStore.calls[0]!.status).toBe("complete");
    expect(inlineToolStore.calls[0]!.output).toBe("done");
    expect(inlineToolStore.calls[0]!.duration).toBe(250);
    expect(inlineToolStore.calls[0]!.cardType).toBe("diff");
    expect(inlineToolStore.calls[0]!.cardLayout).toBe("inline");
  });

  test("updateFromEvent() transitions running->error on tool:error", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", { timestamp: 1000 });
    inlineToolStore.updateFromEvent("inv-1", "tool:error", {
      error: "boom",
      duration: 100,
      cardType: "diff",
      cardLayout: "dock",
    });
    expect(inlineToolStore.calls[0]!.status).toBe("error");
    expect(inlineToolStore.calls[0]!.error).toBe("boom");
    expect(inlineToolStore.calls[0]!.duration).toBe(100);
    expect(inlineToolStore.calls[0]!.retryCount).toBe(1);
    expect(inlineToolStore.calls[0]!.cardType).toBe("diff");
    expect(inlineToolStore.calls[0]!.cardLayout).toBe("dock");
  });

  test("updateFromEvent() is no-op for unknown invocationId", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("unknown-id", "tool:start", { timestamp: 1000 });
    expect(inlineToolStore.calls[0]!.status).toBe("pending");
  });

  test("updateFromEvent() handles object output by JSON.stringifying", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:complete", {
      output: { key: "value" },
      duration: 50,
    });
    expect(inlineToolStore.calls[0]!.output).toBe('{"key":"value"}');
  });

  test("updateFromEvent() unwraps a ToolCallResult envelope via the shared extractor", () => {
    // The four `any`s this file's module used to carry were a hand-copied
    // clone of `extractToolOutput`; the store now delegates to it.
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:complete", {
      output: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      duration: 5,
    });
    expect(inlineToolStore.calls[0]!.output).toBe("first\nsecond");
  });

  test("getByConversation() filters calls by conversationId", () => {
    inlineToolStore.add(makeCall({ id: "inv-1", conversationId: "conv-1" }));
    inlineToolStore.add(makeCall({ id: "inv-2", conversationId: "conv-2" }));
    inlineToolStore.add(makeCall({ id: "inv-3", conversationId: "conv-1" }));
    const filtered = inlineToolStore.getByConversation("conv-1");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((c) => c.id)).toEqual(["inv-1", "inv-3"]);
  });

  test("getById() returns correct call or undefined", () => {
    inlineToolStore.add(makeCall({ id: "inv-1" }));
    inlineToolStore.add(makeCall({ id: "inv-2" }));
    expect(inlineToolStore.getById("inv-2")!.id).toBe("inv-2");
    expect(inlineToolStore.getById("nonexistent")).toBeUndefined();
  });

  test("getByMessage() filters calls by messageId", () => {
    inlineToolStore.add(makeCall({ id: "inv-1", messageId: "m-1" }));
    inlineToolStore.add(makeCall({ id: "inv-2", messageId: "m-2" }));
    expect(inlineToolStore.getByMessage("m-1").map((c) => c.id)).toEqual(["inv-1"]);
  });

  test("remove() deletes call from store", () => {
    inlineToolStore.add(makeCall({ id: "inv-1" }));
    inlineToolStore.add(makeCall({ id: "inv-2" }));
    inlineToolStore.remove("inv-1");
    expect(inlineToolStore.calls).toHaveLength(1);
    expect(inlineToolStore.calls[0]!.id).toBe("inv-2");
  });

  test("remove() is no-op for unknown id", () => {
    inlineToolStore.add(makeCall({ id: "inv-1" }));
    inlineToolStore.remove("unknown");
    expect(inlineToolStore.calls).toHaveLength(1);
  });

  test("multiple sequential error events increment retryCount correctly", () => {
    inlineToolStore.add(makeCall());
    inlineToolStore.updateFromEvent("inv-1", "tool:start", { timestamp: 1000 });
    inlineToolStore.updateFromEvent("inv-1", "tool:error", { error: "fail-1", duration: 50 });
    expect(inlineToolStore.calls[0]!.retryCount).toBe(1);
    inlineToolStore.updateFromEvent("inv-1", "tool:error", { error: "fail-2", duration: 60 });
    expect(inlineToolStore.calls[0]!.retryCount).toBe(2);
    inlineToolStore.updateFromEvent("inv-1", "tool:error", { error: "fail-3", duration: 70 });
    expect(inlineToolStore.calls[0]!.retryCount).toBe(3);
  });
});
