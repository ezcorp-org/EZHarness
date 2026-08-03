/**
 * HTML → markdown extraction for the host-side direct URL reader —
 * `src/search/html-markdown.ts`.
 *
 * Pure, no transport, no network: every case drives `htmlToMarkdown` /
 * `decodeHtmlEntities` over literal markup. This module is what makes
 * `read-url` survive a keyless-Jina ASN block (see
 * docs/features/tools/web-search.md), so the cases below pin the
 * behaviours the fallback depends on: chrome is dropped, `<main>` wins,
 * links resolve against the fetched URL, and entities decode exactly once.
 */
import { describe, expect, test } from "bun:test";
import { decodeHtmlEntities, htmlToMarkdown } from "../search/html-markdown";

describe("decodeHtmlEntities", () => {
  test("decodes hex and decimal numeric character references", () => {
    expect(decodeHtmlEntities("R&#x26;D &#8212; ok &#39;q&#39;")).toBe("R&D — ok 'q'");
  });

  test("decodes the curated named table", () => {
    expect(decodeHtmlEntities("1 &lt; 2 &gt; 0, &quot;q&quot; &apos;a&apos;&nbsp;end")).toBe(
      `1 < 2 > 0, "q" 'a' end`,
    );
    expect(decodeHtmlEntities("&mdash;&ndash;&hellip;&copy;&trade;&rsquo;&euro;")).toBe(
      "—–…©™’€",
    );
  });

  test("leaves an unknown named entity untouched", () => {
    expect(decodeHtmlEntities("&zzzz; &notarealentity;")).toBe("&zzzz; &notarealentity;");
  });

  test("&amp; is decoded LAST so &amp;lt; yields the literal &lt;", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
  });

  test("an out-of-range numeric reference is left as raw text, not thrown", () => {
    // String.fromCodePoint would throw for > 0x10FFFF; a parser callback
    // must never blow up on hostile markup.
    expect(decodeHtmlEntities("&#1114112; &#x110000;")).toBe("&#1114112; &#x110000;");
    expect(decodeHtmlEntities("&#x10FFFF;")).toBe("\u{10FFFF}");
  });
});

describe("htmlToMarkdown — structure", () => {
  test("headings, paragraphs and list items render as markdown", async () => {
    const md = await htmlToMarkdown(
      "<h1>Title</h1><p>Body text.</p><h3>Sub</h3><ul><li>one</li><li>two</li></ul>",
    );
    expect(md).toBe("# Title\n\nBody text.\n\n### Sub\n\n- one\n- two");
  });

  test("consecutive list items stay tight; other blocks get a blank line", async () => {
    const md = await htmlToMarkdown("<ul><li>a</li><li>b</li></ul><p>after</p>");
    expect(md).toBe("- a\n- b\n\nafter");
  });

  test("the document <title> becomes the leading H1", async () => {
    const md = await htmlToMarkdown("<html><head><title>Doc &amp; Title</title></head><body><p>x</p></body></html>");
    expect(md).toBe("# Doc & Title\n\nx");
  });

  test("all six heading levels map to their hash depth", async () => {
    const md = await htmlToMarkdown("<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>");
    expect(md).toBe("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f");
  });

  test("whitespace inside a block is collapsed to single spaces", async () => {
    expect(await htmlToMarkdown("<p>a   b\n\n\tc</p>")).toBe("a b c");
  });

  test("void block elements (br / hr) end the line without an end tag", async () => {
    // Registering onEndTag on a void element throws in HTMLRewriter, so
    // these MUST be handled open-only.
    expect(await htmlToMarkdown("<p>one<br>two</p><hr><p>three</p>")).toBe("one\n\ntwo\n\nthree");
  });

  test("table rows split into one line per cell", async () => {
    expect(await htmlToMarkdown("<table><tr><td>c1</td><td>c2</td></tr></table>")).toBe("c1\n\nc2");
  });

  test("bare body text with no block wrapper still surfaces", async () => {
    expect(await htmlToMarkdown("<html><body>loose text</body></html>")).toBe("loose text");
  });

  test("inline elements do not break the line", async () => {
    expect(await htmlToMarkdown("<p>Hello <b>bold</b> and <em>em</em>.</p>")).toBe(
      "Hello bold and em.",
    );
  });

  test("empty input and tag-free input produce no markdown", async () => {
    expect(await htmlToMarkdown("")).toBe("");
    // No elements at all → HTMLRewriter emits no text events; the direct
    // reader turns this into an explicit "no readable text" error.
    expect(await htmlToMarkdown("plain text, no tags")).toBe("");
  });
});

describe("htmlToMarkdown — chrome stripping", () => {
  test("script / style / noscript / svg / canvas / iframe / template text is dropped", async () => {
    const md = await htmlToMarkdown(
      "<style>.a{color:red}</style><script>var x = 1 < 2;</script>" +
        "<noscript>enable js</noscript><svg><text>vector</text></svg>" +
        "<canvas>fallback</canvas><iframe>frame</iframe><template><p>tpl</p></template>" +
        "<p>real content</p>",
    );
    expect(md).toBe("real content");
  });

  test("nav / header / footer / aside subtrees are dropped whole", async () => {
    const md = await htmlToMarkdown(
      "<header><h1>chrome</h1></header><nav><ul><li><a href='/x'>Nav</a></li></ul></nav>" +
        "<p>keep me</p><aside><p>side</p></aside><footer><p>foot</p></footer>",
    );
    expect(md).toBe("keep me");
  });

  test("a dropped subtree nested inside another dropped subtree stays dropped", async () => {
    const md = await htmlToMarkdown("<nav><aside><p>deep chrome</p></aside>tail</nav><p>kept</p>");
    expect(md).toBe("kept");
  });

  test("dropping closes the line in progress instead of swallowing it", async () => {
    expect(await htmlToMarkdown("<div>before<nav>chrome</nav>after</div>")).toBe("before\n\nafter");
  });
});

describe("htmlToMarkdown — <main> / <article> preference", () => {
  test("only <main> content is returned when the page has one", async () => {
    const md = await htmlToMarkdown(
      "<p>preamble</p><main><h1>Real</h1><p>content</p></main><p>postamble</p>",
    );
    expect(md).toBe("# Real\n\ncontent");
  });

  test("<article> counts as main content too", async () => {
    const md = await htmlToMarkdown("<p>junk</p><article><p>the story</p></article>");
    expect(md).toBe("the story");
  });

  test("the LAST line of <main> is still attributed to it", async () => {
    // Regression guard: the closing-tag flush must run BEFORE the main-depth
    // decrement, or the final paragraph silently drops out of the result.
    const md = await htmlToMarkdown("<main><p>first</p><p>last</p></main><p>outside</p>");
    expect(md).toBe("first\n\nlast");
  });

  test("an EMPTY <main> falls back to the whole document", async () => {
    const md = await htmlToMarkdown("<p>everything</p><main></main>");
    expect(md).toBe("everything");
  });
});

describe("htmlToMarkdown — links", () => {
  test("relative hrefs resolve against the fetched URL", async () => {
    const md = await htmlToMarkdown(
      `<p>see <a href="/rel/a?x=1&amp;y=2">the docs</a>.</p>`,
      "https://example.com/docs/page",
    );
    expect(md).toBe("see [the docs](https://example.com/rel/a?x=1&y=2).");
  });

  test("absolute http(s) and mailto links are kept", async () => {
    const md = await htmlToMarkdown(
      `<p><a href="https://a.test/x">A</a> <a href="mailto:x@y.test">Mail</a></p>`,
    );
    expect(md).toBe("[A](https://a.test/x) [Mail](mailto:x@y.test)");
  });

  test("fragment, javascript:, empty and unresolvable hrefs degrade to plain text", async () => {
    const md = await htmlToMarkdown(
      `<p><a href="#top">frag</a> <a href="javascript:alert(1)">js</a> ` +
        `<a href="">empty</a> <a>bare</a> <a href="/rel">no-base</a></p>`,
    );
    expect(md).toBe("frag js empty bare no-base");
  });

  test("an anchor with no text emits nothing at all", async () => {
    expect(await htmlToMarkdown(`<p>a<a href="https://x.test/"></a>b</p>`)).toBe("ab");
  });

  test("link text spanning whitespace is collapsed inside the link", async () => {
    expect(await htmlToMarkdown(`<p><a href="https://x.test/">two\n  words</a></p>`)).toBe(
      "[two words](https://x.test/)",
    );
  });

  test("a block boundary inside an anchor ships the text and drops the link", async () => {
    // `<a><div>…</div></a>` — the div flushes the line out from under the
    // anchor, so there is nothing left to rewrite when it closes.
    expect(await htmlToMarkdown(`<a href="https://x.test/"><div>boxed</div></a>`)).toBe("boxed");
  });

  test("a link inside dropped chrome never reaches the output", async () => {
    expect(await htmlToMarkdown(`<nav><a href="https://x.test/">nav</a></nav><p>body</p>`)).toBe(
      "body",
    );
  });
});

describe("htmlToMarkdown — <pre> blocks", () => {
  test("pre content keeps its line breaks inside a fence", async () => {
    const md = await htmlToMarkdown(
      "<p>before</p><pre><code>const a = 1;\nif (a &lt; 2) {\n  go();\n}</code></pre><p>after</p>",
    );
    expect(md).toBe(
      "before\n\n```\nconst a = 1;\nif (a < 2) {\n  go();\n}\n```\n\nafter",
    );
  });

  test("block tags inside <pre> are literal, not structure", async () => {
    expect(await htmlToMarkdown("<pre>a\n<div>b</div>\nc</pre>")).toBe("```\na\nb\nc\n```");
  });

  test("an empty <pre> emits nothing", async () => {
    expect(await htmlToMarkdown("<pre>   </pre><p>x</p>")).toBe("x");
  });
});

describe("htmlToMarkdown — a realistic page", () => {
  const PAGE = `<!doctype html><html><head><title>Bun &mdash; docs</title>
<style>body{margin:0}</style><script>analytics()</script></head><body>
<header><a href="/">Home</a></header>
<nav><a href="/a">A</a><a href="/b">B</a></nav>
<main>
  <h1>Install</h1>
  <p>Run <a href="/install">the installer</a> &amp; you&#39;re done.</p>
  <h2>Notes</h2>
  <ul><li>fast</li><li>batteries included</li></ul>
  <pre><code>bun install</code></pre>
</main>
<footer><p>&copy; 2026</p></footer>
</body></html>`;

  test("extracts only the article body, with usable links", async () => {
    const md = await htmlToMarkdown(PAGE, "https://bun.example/docs/install");
    expect(md).toBe(
      [
        "# Install",
        "",
        "Run [the installer](https://bun.example/install) & you're done.",
        "",
        "## Notes",
        "",
        "- fast",
        "- batteries included",
        "",
        "```\nbun install\n```",
      ].join("\n"),
    );
  });

  test("no chrome, no scripts, no styles leak into the output", async () => {
    const md = await htmlToMarkdown(PAGE, "https://bun.example/docs/install");
    expect(md).not.toContain("analytics");
    expect(md).not.toContain("margin:0");
    expect(md).not.toContain("Home");
    expect(md).not.toContain("2026");
  });
});
