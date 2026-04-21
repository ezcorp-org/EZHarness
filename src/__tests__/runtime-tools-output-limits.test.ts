import { test, expect, describe } from "bun:test";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  TOOL_OUTPUT_LIMITS,
  getToolOutputLimit,
  formatBytes,
  buildTruncationMarker,
  buildStreamTruncationMarker,
  truncateText,
  describeOutputCap,
} from "../runtime/tools/output-limits";

// ── Caps & lookup ──

describe("output-limits caps", () => {
  test("DEFAULT_MAX_OUTPUT_BYTES sits safely under OpenAI's 10 MiB hard limit", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(10 * 1024 * 1024);
    // At least 1 MB of headroom for markers/overhead.
    expect(10 * 1024 * 1024 - DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  test("shell cap is overridden to 1 MiB in TOOL_OUTPUT_LIMITS", () => {
    expect(TOOL_OUTPUT_LIMITS.shell).toBe(1 * 1024 * 1024);
  });

  test("getToolOutputLimit returns the override for shell and the default for unknown tools", () => {
    expect(getToolOutputLimit("shell")).toBe(1 * 1024 * 1024);
    expect(getToolOutputLimit("readFile")).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(getToolOutputLimit("nonexistent_tool_xyz")).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  });
});

// ── formatBytes ──

describe("formatBytes", () => {
  test("formats MB cleanly for integer and fractional values", () => {
    expect(formatBytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });

  test("formats KB below 1 MB", () => {
    expect(formatBytes(4 * 1024)).toBe("4 KB");
    expect(formatBytes(1024)).toBe("1 KB");
  });

  test("formats bytes when below 1 KB", () => {
    expect(formatBytes(256)).toBe("256 B");
    expect(formatBytes(0)).toBe("0 B");
  });
});

// ── truncateText ──

describe("truncateText", () => {
  test("returns text unchanged when below the cap", () => {
    const r = truncateText("hello", 100, "readFile");
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.originalBytes).toBe(5);
  });

  test("truncates oversized text and appends a marker with accurate numbers", () => {
    const input = "A".repeat(10_000);
    const r = truncateText(input, 1000, "readFile");
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBe(10_000);
    expect(r.text.startsWith("A".repeat(1000))).toBe(true);
    expect(r.text).toContain("readFile cap is");
    expect(r.text).toContain("[output truncated:");
  });

  test("survives a cut inside a multi-byte UTF-8 sequence without throwing", () => {
    // "é" = 2 bytes. Capping at an odd byte count splits one of them.
    const input = "é".repeat(500);
    const r = truncateText(input, 101, "readFile");
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[output truncated:");
  });
});

// ── Markers ──

describe("truncation markers", () => {
  test("buildTruncationMarker includes tool name, cap, omitted, and total", () => {
    const marker = buildTruncationMarker("shell", 2 * 1024, 3 * 1024, 1024);
    expect(marker).toContain("shell cap is 1 KB");
    expect(marker).toContain("2 KB omitted of 3 KB total");
    expect(marker.startsWith("\n[output truncated:")).toBe(true);
  });

  test("buildStreamTruncationMarker names the cap for stream-mode tools", () => {
    const marker = buildStreamTruncationMarker("shell", 1024 * 1024);
    expect(marker).toContain("shell cap is 1 MB");
    expect(marker).toContain("stream terminated at cap");
  });
});

// ── describeOutputCap ──

describe("describeOutputCap", () => {
  test("surfaces the cap in a human sentence", () => {
    expect(describeOutputCap("shell")).toContain("1 MB");
    expect(describeOutputCap("readFile")).toContain("8 MB");
  });
});
