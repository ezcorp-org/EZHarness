/**
 * Unit tests for the pure system-block cache-split helper
 * (src/runtime/stream-chat/system-cache-split.ts): the volatile memory/KB
 * tail is appended as the LAST system block with NO cache_control, the
 * frozen prefix blocks are never touched, and the tail text is sanitized
 * the same way pi-ai sanitizes its own system blocks (unpaired-surrogate
 * strip). 100% of the module.
 */
import { test, expect, describe } from "bun:test";
import { appendMemoryTailBlock } from "../runtime/stream-chat/system-cache-split";

const TAIL = "\n\n## Relevant Memories\n- [preferences] dark mode (confidence: high)";

describe("appendMemoryTailBlock", () => {
  test("pushes the tail as the LAST system block with NO cache_control (frozen blocks untouched)", () => {
    const frozen = { type: "text", text: "sys", cache_control: { type: "ephemeral" } };
    const frozenBytes = JSON.stringify(frozen);
    const payload: any = { system: [frozen], tools: [{ name: "t" }] };

    const out = appendMemoryTailBlock(payload, TAIL) as any;

    expect(out).toBe(payload); // mutates in place, returns the payload
    expect(out.system).toHaveLength(2);
    expect(out.system[1]).toEqual({ type: "text", text: TAIL });
    expect("cache_control" in out.system[1]).toBe(false);
    // The frozen prefix block is byte-identical — no breakpoint moved.
    expect(JSON.stringify(out.system[0])).toBe(frozenBytes);
    expect(out.tools).toEqual([{ name: "t" }]);
  });

  test("appends after ALL existing blocks (OAuth shape: identity + frozen + tail)", () => {
    const payload: any = {
      system: [
        { type: "text", text: "identity", cache_control: { type: "ephemeral" } },
        { type: "text", text: "frozen", cache_control: { type: "ephemeral" } },
      ],
    };

    const out = appendMemoryTailBlock(payload, TAIL) as any;

    expect(out.system).toHaveLength(3);
    expect(out.system[2]).toEqual({ type: "text", text: TAIL });
    // Breakpoint budget unchanged: exactly the original 2 cache_control marks.
    const breakpoints = out.system.filter((b: any) => b.cache_control);
    expect(breakpoints).toHaveLength(2);
  });

  test("creates the system array when absent (memory is never dropped)", () => {
    const payload: any = { messages: [] };

    const out = appendMemoryTailBlock(payload, TAIL) as any;

    expect(out.system).toEqual([{ type: "text", text: TAIL }]);
  });

  test("creates the system array when system is an empty string", () => {
    const payload: any = { system: "" };

    const out = appendMemoryTailBlock(payload, TAIL) as any;

    expect(out.system).toEqual([{ type: "text", text: TAIL }]);
  });

  test("converts a non-empty string system to block form, then appends (no cache_control added)", () => {
    const payload: any = { system: "plain string prompt" };

    const out = appendMemoryTailBlock(payload, TAIL) as any;

    expect(out.system).toEqual([
      { type: "text", text: "plain string prompt" },
      { type: "text", text: TAIL },
    ]);
    expect(out.system.some((b: any) => b.cache_control)).toBe(false);
  });

  test("empty/undefined tail is a strict no-op", () => {
    const payload: any = { system: [{ type: "text", text: "sys" }] };
    const bytes = JSON.stringify(payload);

    expect(appendMemoryTailBlock(payload, "")).toBe(payload);
    expect(appendMemoryTailBlock(payload, undefined)).toBe(payload);
    expect(JSON.stringify(payload)).toBe(bytes);
  });

  test("non-object / null payloads are returned untouched", () => {
    expect(appendMemoryTailBlock(null, TAIL)).toBe(null);
    expect(appendMemoryTailBlock(undefined, TAIL)).toBe(undefined);
    expect(appendMemoryTailBlock("body", TAIL)).toBe("body");
  });

  test("strips unpaired surrogates from the tail (pi-ai sanitizeSurrogates parity), keeps paired emoji", () => {
    const unpairedHigh = String.fromCharCode(0xd83d); // high surrogate, no low
    const unpairedLow = String.fromCharCode(0xdc00); // low surrogate, no high
    const dirty = `memo ${unpairedHigh} 🙈 ${unpairedLow} end`;
    const payload: any = { system: [] };

    const out = appendMemoryTailBlock(payload, dirty) as any;

    // Unpaired surrogates removed; the properly-paired 🙈 survives.
    expect(out.system[0].text).toBe("memo  🙈  end");
  });
});
