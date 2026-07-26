/**
 * `src/runtime/chat-graph/labels.ts` + `order.ts` — the two shared
 * primitives both graph builders depend on.
 *
 * They are tested together because they are tested the same way: pure
 * functions, no fixtures, every rule stated in their doc comments pinned
 * by an assertion.
 */

import { describe, expect, test } from "bun:test";
import { LABEL_MAX, truncateLabel } from "../runtime/chat-graph/labels";
import { byCreatedAtThenId, toMs } from "../runtime/chat-graph/order";

describe("truncateLabel", () => {
  test("short single-line text passes through with no fullLabel", () => {
    const result = truncateLabel("Refactor the parser");
    expect(result).toEqual({ label: "Refactor the parser" });
    expect(result.fullLabel).toBeUndefined();
  });

  test("text exactly at the budget is not clamped", () => {
    const exact = "x".repeat(LABEL_MAX);
    expect(truncateLabel(exact)).toEqual({ label: exact });
  });

  test("one char over the budget clamps to LABEL_MAX including the ellipsis", () => {
    const raw = "y".repeat(LABEL_MAX + 1);
    const result = truncateLabel(raw);
    expect(result.label).toHaveLength(LABEL_MAX);
    expect(result.label.endsWith("…")).toBe(true);
    expect(result.fullLabel).toBe(raw);
  });

  test("whitespace is collapsed, and that alone sets fullLabel", () => {
    const raw = "  first line\n\n\tsecond line  ";
    const result = truncateLabel(raw);
    expect(result.label).toBe("first line second line");
    // Nothing was clamped, but the label no longer equals the input, so the
    // detail pane must still be able to recover the original.
    expect(result.fullLabel).toBe(raw);
  });

  test("a newline does not eat the budget — the flattened text is measured", () => {
    const raw = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    const result = truncateLabel(raw);
    // 30 + 1 space + 30 = 61 > LABEL_MAX, so it clamps rather than
    // silently keeping an invisible character.
    expect(result.label).toHaveLength(LABEL_MAX);
    expect(result.label.startsWith("a".repeat(30))).toBe(true);
  });

  test("empty text yields an empty label and no fullLabel", () => {
    expect(truncateLabel("")).toEqual({ label: "" });
  });
});

describe("byCreatedAtThenId", () => {
  const at = (id: string, createdAt: string) => ({ id, createdAt });

  test("orders by createdAt ascending", () => {
    const sorted = [at("b", "2026-07-26T00:00:02.000Z"), at("a", "2026-07-26T00:00:01.000Z")].sort(
      byCreatedAtThenId,
    );
    expect(sorted.map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("breaks a same-millisecond tie by id", () => {
    const ts = "2026-07-26T00:00:00.000Z";
    const sorted = [at("tc-3", ts), at("tc-1", ts), at("tc-2", ts)].sort(byCreatedAtThenId);
    expect(sorted.map((n) => n.id)).toEqual(["tc-1", "tc-2", "tc-3"]);
  });

  test("identical id and timestamp compare equal", () => {
    const ts = "2026-07-26T00:00:00.000Z";
    expect(byCreatedAtThenId(at("same", ts), at("same", ts))).toBe(0);
  });

  test("compares numerically, so an offset-bearing ISO string still sorts right", () => {
    // "2026-07-26T03:00:00+02:00" is 01:00Z — EARLIER than 02:00Z, even
    // though it sorts LATER as plain text.
    const earlier = at("offset", "2026-07-26T03:00:00+02:00");
    const later = at("utc", "2026-07-26T02:00:00.000Z");
    expect(byCreatedAtThenId(earlier, later)).toBeLessThan(0);
  });
});

describe("toMs", () => {
  test("parses ISO-8601 to epoch milliseconds", () => {
    expect(toMs("1970-01-01T00:00:01.500Z")).toBe(1500);
  });

  test("an unparseable value yields NaN, which fails every comparison", () => {
    const ms = toMs("not-a-timestamp");
    expect(Number.isNaN(ms)).toBe(true);
    expect(ms < 0).toBe(false);
    expect(ms > 0).toBe(false);
  });
});
