/** Markdown helpers — `src/search/markdown.ts`. */
import { test, expect, describe } from "bun:test";
import { formatResults, truncate } from "../search/markdown";

describe("formatResults", () => {
  test("renders a bullet list with title, link, and snippet", () => {
    expect(
      formatResults([
        { title: "Bun", url: "https://bun.sh", snippet: "A runtime" },
        { title: "TS", url: "https://ts.dev", snippet: "" },
      ]),
    ).toBe("- [Bun](https://bun.sh)\n  A runtime\n- [TS](https://ts.dev)");
  });

  test("falls back to the URL when the title is blank", () => {
    expect(formatResults([{ title: "   ", url: "https://x", snippet: "" }])).toBe("- [https://x](https://x)");
  });

  test("empty results → _No results._", () => {
    expect(formatResults([])).toBe("_No results._");
  });
});

describe("truncate", () => {
  test("returns the string unchanged when within the cap", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  test("truncates with a trailing ellipsis at exactly n chars", () => {
    const out = truncate("hello world", 5);
    expect(out).toBe("hell…");
    expect(out.length).toBe(5);
  });

  test("n <= 1 edge cases", () => {
    expect(truncate("hello", 1)).toBe("…");
    expect(truncate("hello", 0)).toBe("");
  });
});
