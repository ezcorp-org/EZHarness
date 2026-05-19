/**
 * markdownToSpeech — strips markdown so TTS speaks clean prose, never
 * "asterisk asterisk bold" / spelled-out URLs / code fences.
 *
 * The anchor invariant: plain prose is returned verbatim (the bridge
 * feeds every synthesis through this, and bridge tests assert exact
 * passthrough of strings like "hello"). Everything else verifies a
 * markdown construct's *syntax* is gone while its spoken content
 * survives.
 */

import { test, expect, describe } from "bun:test";
import { markdownToSpeech } from "../markdown-speech";

describe("markdownToSpeech", () => {
  test("plain prose is returned verbatim (bridge passthrough invariant)", () => {
    expect(markdownToSpeech("hello")).toBe("hello");
    expect(markdownToSpeech("first")).toBe("first");
    expect(markdownToSpeech("a normal sentence, with punctuation!")).toBe(
      "a normal sentence, with punctuation!",
    );
  });

  test("empty / whitespace-only → empty string", () => {
    expect(markdownToSpeech("")).toBe("");
    expect(markdownToSpeech("   \n\n  ")).toBe("");
  });

  test("bold/italic/strike markers removed, words kept", () => {
    expect(markdownToSpeech("**bold**")).toBe("bold");
    expect(markdownToSpeech("__bold__")).toBe("bold");
    expect(markdownToSpeech("*italic*")).toBe("italic");
    expect(markdownToSpeech("_em_")).toBe("em");
    expect(markdownToSpeech("~~struck~~")).toBe("struck");
    expect(markdownToSpeech("**_nested_**")).toBe("nested");
    expect(markdownToSpeech("say **this** and *that*")).toBe(
      "say this and that",
    );
  });

  test("headings: hashes gone, text kept, separated from body", () => {
    expect(markdownToSpeech("# Title")).toBe("Title");
    expect(markdownToSpeech("###### deep")).toBe("deep");
    expect(markdownToSpeech("## A\n\nBody text")).toBe("A\nBody text");
  });

  test("inline code kept; fenced code blocks dropped", () => {
    expect(markdownToSpeech("run `npm test` now")).toBe("run npm test now");
    expect(
      markdownToSpeech("before\n\n```js\nconst x = 1;\n```\n\nafter"),
    ).toBe("before\nafter");
  });

  test("links speak the label, never the URL", () => {
    expect(markdownToSpeech("[Anthropic](https://anthropic.com)")).toBe(
      "Anthropic",
    );
    expect(
      markdownToSpeech("see [the docs](https://example.com/a/b?c=d) please"),
    ).toBe("see the docs please");
  });

  test("images are dropped entirely", () => {
    expect(markdownToSpeech("![alt text](pic.png)")).toBe("");
    expect(markdownToSpeech("look ![x](y.png) here")).toBe("look here");
  });

  test("lists: bullets/numbers gone, items become separate lines", () => {
    expect(markdownToSpeech("- a\n- b\n- c")).toBe("a\nb\nc");
    expect(markdownToSpeech("1. one\n2. two")).toBe("one\ntwo");
    expect(markdownToSpeech("* first item\n* second item")).toBe(
      "first item\nsecond item",
    );
  });

  test("blockquotes: marker gone, quoted text kept", () => {
    expect(markdownToSpeech("> a quoted line")).toBe("a quoted line");
  });

  test("thematic breaks (---, ***, ___) are removed", () => {
    expect(markdownToSpeech("a\n\n---\n\nb")).toBe("a\nb");
    expect(markdownToSpeech("a\n\n***\n\nb")).toBe("a\nb");
  });

  test("tables: pipes and separator row gone, cells readable", () => {
    const md = [
      "| Name | Role |",
      "|------|------|",
      "| Ada  | Eng  |",
      "| Bob  | PM   |",
    ].join("\n");
    expect(markdownToSpeech(md)).toBe("Name, Role\nAda, Eng\nBob, PM");
  });

  test("raw HTML tags are stripped, entities decoded", () => {
    expect(markdownToSpeech("<b>hi</b> <i>there</i>")).toBe("hi there");
    expect(markdownToSpeech("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });

  test("unbalanced / standalone markers don't get spoken", () => {
    expect(markdownToSpeech("para\n\n**\n\nmore")).toBe("para\nmore");
    expect(markdownToSpeech("a ** b")).toBe("a b");
    expect(markdownToSpeech("## Heading -- with **emphasis**")).toBe(
      "Heading, with emphasis",
    );
  });

  test("hyphenated words and snake_case survive (no over-stripping)", () => {
    expect(markdownToSpeech("a well-known fact")).toBe("a well-known fact");
    expect(markdownToSpeech("call snake_case_fn here")).toBe(
      "call snake_case_fn here",
    );
  });

  test("kitchen-sink: no markdown control chars remain", () => {
    const md = [
      "# Release Notes",
      "",
      "We shipped **fast streaming** and fixed the [hang bug](https://x.com/i).",
      "",
      "## Changes",
      "- Faster `synthesize()` path",
      "- Removed the *16s* cap",
      "",
      "> Thanks to everyone.",
      "",
      "| Metric | Before | After |",
      "|--------|--------|-------|",
      "| Limit  | 16s    | none  |",
      "",
      "```ts",
      "const truncated = false;",
      "```",
      "",
      "Done.",
    ].join("\n");

    const out = markdownToSpeech(md);
    // None of the structural markdown punctuation should survive.
    expect(out).not.toMatch(/[#*`|~]/);
    expect(out).not.toContain("](http");
    expect(out).not.toContain("```");
    // Spoken content is intact.
    expect(out).toContain("Release Notes");
    expect(out).toContain("fast streaming");
    expect(out).toContain("hang bug");
    expect(out).toContain("synthesize()");
    expect(out).toContain("Thanks to everyone.");
    expect(out).toContain("Done.");
    // Code-block body is NOT read aloud.
    expect(out).not.toContain("const truncated");
    // URL is NOT read aloud.
    expect(out).not.toContain("x.com");
  });
});
