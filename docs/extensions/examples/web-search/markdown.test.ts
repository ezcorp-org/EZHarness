import { describe, expect, test } from "bun:test";
import { formatResults, truncate } from "./markdown";
import type { SearchResult } from "./providers";

describe("formatResults", () => {
  test("empty list returns a _No results._ sentinel", () => {
    expect(formatResults([])).toBe("_No results._");
  });

  test("renders title + url + snippet per result", () => {
    const r: SearchResult[] = [
      { title: "A", url: "https://a", snippet: "snip a" },
      { title: "B", url: "https://b", snippet: "snip b" },
    ];
    expect(formatResults(r)).toBe("- [A](https://a)\n  snip a\n- [B](https://b)\n  snip b");
  });

  test("falls back to url when title is blank", () => {
    expect(
      formatResults([{ title: "   ", url: "https://fallback", snippet: "" }]),
    ).toBe("- [https://fallback](https://fallback)");
  });

  test("omits snippet line when snippet is whitespace-only", () => {
    expect(
      formatResults([{ title: "T", url: "https://t", snippet: "   " }]),
    ).toBe("- [T](https://t)");
  });
});

describe("truncate", () => {
  test("returns input unchanged when within budget", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  test("truncates and appends an ellipsis at exact length n", () => {
    const out = truncate("abcdefghij", 6);
    expect(out).toHaveLength(6);
    expect(out).toBe("abcde\u2026");
  });

  test("n=1 yields a single ellipsis", () => {
    expect(truncate("long string", 1)).toBe("\u2026");
  });

  test("n=0 yields empty string", () => {
    expect(truncate("long string", 0)).toBe("");
  });
});
