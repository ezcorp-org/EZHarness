/**
 * Unit tests for prompt-cache retention shaping
 * (`src/runtime/stream-chat/cache-retention.ts`). Pure module — no DB, no
 * network. Covers the settings validator and the per-request payload
 * adjuster that keeps the stable prefix (system + last tool) on a 1h TTL
 * while leaving the conversation tail short, plus the `none`/`short` and
 * non-Anthropic (no-op) paths.
 */
import { test, expect, describe } from "bun:test";
import {
  resolveCacheRetentionSetting,
  applyCacheRetention,
  DEFAULT_CACHE_RETENTION,
  type CacheRetention,
} from "../runtime/stream-chat/cache-retention";

type CacheControl = { type: string; ttl?: string };
type Block = {
  type?: string;
  text?: string;
  name?: string;
  content?: Block[];
  cache_control?: CacheControl;
};
interface Payload {
  system: Block[];
  tools: Block[];
  messages: Array<{ role: string; content: Block[] }>;
}

const ephemeral = (): CacheControl => ({ type: "ephemeral" });

/** A fully-marked Anthropic payload: cache_control on system, last tool, tail. */
function anthropicPayload(): Payload {
  return {
    system: [
      { type: "text", text: "identity", cache_control: ephemeral() },
      { type: "text", text: "sys" }, // no cache_control (long loop skip branch)
    ],
    tools: [{ name: "a" }, { name: "b", cache_control: ephemeral() }],
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "q1" },
          { type: "text", text: "q2", cache_control: ephemeral() },
        ],
      },
    ],
  };
}

describe("resolveCacheRetentionSetting", () => {
  test.each(["short", "long", "none"] as const)("accepts %s", (v) => {
    expect(resolveCacheRetentionSetting(v)).toBe(v);
  });
  test("rejects anything else", () => {
    expect(resolveCacheRetentionSetting("forever")).toBeUndefined();
    expect(resolveCacheRetentionSetting(undefined)).toBeUndefined();
    expect(resolveCacheRetentionSetting(5)).toBeUndefined();
    expect(resolveCacheRetentionSetting(null)).toBeUndefined();
  });
  test("the module default is long", () => {
    expect(DEFAULT_CACHE_RETENTION).toBe("long" satisfies CacheRetention);
  });
});

describe("applyCacheRetention", () => {
  test("short: returns the payload untouched (pi-ai default 5m)", () => {
    const p = anthropicPayload();
    const out = applyCacheRetention(p, true, "short") as typeof p;
    expect(out).toBe(p);
    expect(out.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("long + supported: 1h TTL on system + last tool, tail stays short", () => {
    const p = anthropicPayload();
    const out = applyCacheRetention(p, true, "long") as typeof p;
    expect(out.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The system block WITHOUT cache_control is left alone.
    expect(out.system[1]!.cache_control).toBeUndefined();
    // Last tool → 1h; earlier tool has no breakpoint.
    expect(out.tools[1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.tools[0]!.cache_control).toBeUndefined();
    // Conversation tail (last message's last block) stays short (5m).
    expect(out.messages[1]!.content[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("long + UNSUPPORTED model: no TTL change", () => {
    const p = anthropicPayload();
    const out = applyCacheRetention(p, false, "long") as typeof p;
    expect(out.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(out.tools[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("none: strips cache_control from prefix AND tail", () => {
    const p = anthropicPayload();
    const out = applyCacheRetention(p, true, "none") as typeof p;
    expect(out.system[0]!.cache_control).toBeUndefined();
    expect(out.tools[1]!.cache_control).toBeUndefined();
    expect(out.messages[1]!.content[1]!.cache_control).toBeUndefined();
  });

  test("non-object payloads are returned as-is (non-Anthropic providers)", () => {
    expect(applyCacheRetention(undefined, true, "long")).toBeUndefined();
    expect(applyCacheRetention(null, true, "none")).toBeNull();
    expect(applyCacheRetention("body", true, "long")).toBe("body");
  });

  test("handles missing/empty system, tools, and messages gracefully", () => {
    // No arrays anywhere → nothing to mark, no throw.
    const p1: Record<string, unknown> = {};
    expect(applyCacheRetention(p1, true, "long")).toBe(p1);
    // Empty collections exercise the lastTool/lastMsg undefined branches.
    const p2 = { system: "not-an-array", tools: [], messages: [] };
    const out = applyCacheRetention(p2, true, "none");
    expect(out).toBe(p2);
  });
});
