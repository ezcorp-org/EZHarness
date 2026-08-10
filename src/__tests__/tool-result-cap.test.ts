/**
 * `compaction:toolResultCap` — the tolerant READ, the strict WRITE, and the
 * link back to the transform they configure.
 *
 * The read falls back to the 32000 default for anything malformed (a settings
 * row must never fail a turn), which is exactly why the write has to refuse
 * those values loudly — otherwise `"16000"` stores fine, changes nothing, and
 * the knob looks broken. The last two describe blocks pin write ⊆ read and
 * that an accepted cap actually reaches `capStaleToolResults` as written.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_TOOL_RESULT_CAP,
  TOOL_RESULT_CAP_SETTING_KEY,
  parseToolResultCap,
  validateToolResultCap,
} from "../runtime/stream-chat/tool-result-cap";
import { DEFAULTS, capStaleToolResults } from "../runtime/stream-chat/context-compaction";

describe("constants", () => {
  test("the settings key is the documented one", () => {
    expect(TOOL_RESULT_CAP_SETTING_KEY).toBe("compaction:toolResultCap");
  });

  test("the compaction DEFAULTS use this module's numbers — one definition", () => {
    expect(DEFAULTS.toolResultCap).toBe(DEFAULT_TOOL_RESULT_CAP);
    expect(DEFAULTS.charsPerToken).toBe(CHARS_PER_TOKEN_ESTIMATE);
  });

  test("the default is 32000 characters", () => {
    expect(DEFAULT_TOOL_RESULT_CAP).toBe(32_000);
  });
});

describe("parseToolResultCap — tolerant read", () => {
  test("passes a configured cap through", () => {
    expect(parseToolResultCap(16_000)).toBe(16_000);
  });

  test("0 is meaningful and survives — it disables the cap", () => {
    expect(parseToolResultCap(0)).toBe(0);
  });

  test("an absent row reads as the default", () => {
    expect(parseToolResultCap(undefined)).toBe(DEFAULT_TOOL_RESULT_CAP);
    expect(parseToolResultCap(null)).toBe(DEFAULT_TOOL_RESULT_CAP);
  });

  test("malformed values fall back to the default, never to off or unbounded", () => {
    for (const bad of ["16000", -1, Number.NaN, Number.POSITIVE_INFINITY, true, {}, [16_000]]) {
      expect(parseToolResultCap(bad)).toBe(DEFAULT_TOOL_RESULT_CAP);
    }
  });
});

describe("validateToolResultCap — strict write", () => {
  test("accepts a positive whole number", () => {
    expect(validateToolResultCap(16_000)).toEqual({ ok: true, cap: 16_000 });
  });

  test("accepts 0 — switching the cost control off is a legitimate choice", () => {
    expect(validateToolResultCap(0)).toEqual({ ok: true, cap: 0 });
  });

  test("REJECTS a numeric string rather than storing an ignored row", () => {
    const res = validateToolResultCap("16000");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.error).toContain("whole number of characters");
  });

  test("REJECTS non-finite numbers", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateToolResultCap(bad).ok).toBe(false);
    }
  });

  test("REJECTS a negative cap and points at 0 as the disable value", () => {
    const res = validateToolResultCap(-1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.error).toContain("use 0 to disable");
  });

  test("REJECTS a fractional cap — it is split head/tail", () => {
    const res = validateToolResultCap(1_000.5);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.error).toContain("whole number");
  });
});

describe("write ⊆ read — nothing storable is unreadable", () => {
  test("every accepted cap survives the tolerant read unchanged", () => {
    for (const value of [0, 1, 512, DEFAULT_TOOL_RESULT_CAP, 1_000_000]) {
      const res = validateToolResultCap(value);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(`expected ${value} to be accepted`);
      expect(parseToolResultCap(res.cap)).toBe(value);
    }
  });

  test("the read's fallback is itself a writable cap", () => {
    expect(validateToolResultCap(DEFAULT_TOOL_RESULT_CAP).ok).toBe(true);
  });
});

describe("an accepted cap reaches the transform it configures", () => {
  const stale = (text: string): AgentMessage =>
    ({
      role: "toolResult",
      toolName: "read",
      toolCallId: "c1",
      content: [{ type: "text", text }],
    }) as unknown as AgentMessage;
  const newest = (): AgentMessage =>
    ({
      role: "toolResult",
      toolName: "read",
      toolCallId: "c2",
      content: [{ type: "text", text: "z".repeat(5_000) }],
    }) as unknown as AgentMessage;

  test("a small accepted cap actually shortens an older tool result", () => {
    const res = validateToolResultCap(200);
    if (!res.ok) throw new Error("expected 200 to be accepted");
    const messages = [stale("a".repeat(5_000)), newest()];
    const out = capStaleToolResults(messages, {
      ...DEFAULTS,
      toolResultCap: parseToolResultCap(res.cap),
    });

    expect(out).not.toBe(messages);
    const capped = out[0] as { content: { type: string; text: string }[] };
    expect(capped.content[0]!.text.length).toBeLessThan(5_000);
    // The newest result is never capped — that is what the agent is reading now.
    expect(out[1]).toBe(messages[1]);
  });

  test("the accepted 0 really is off — the array comes back by identity", () => {
    const res = validateToolResultCap(0);
    if (!res.ok) throw new Error("expected 0 to be accepted");
    const messages = [stale("a".repeat(5_000)), newest()];
    expect(
      capStaleToolResults(messages, { ...DEFAULTS, toolResultCap: parseToolResultCap(res.cap) }),
    ).toBe(messages);
  });
});
