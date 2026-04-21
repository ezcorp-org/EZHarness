import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "$lib/markdown.js";

describe("code block rendering", () => {
	test("wraps code block in code-block-wrapper div", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```");
		expect(html).toContain('class="code-block-wrapper"');
	});

	test("includes copy button with escaped data-code attribute", () => {
		const html = renderMarkdown('```js\nconst x = "<div>";\n```');
		expect(html).toContain('class="copy-btn"');
		expect(html).toContain("data-code=");
		expect(html).toContain("&lt;div&gt;");
	});

	test("shows language label when lang specified", () => {
		const html = renderMarkdown("```typescript\nconst x = 1;\n```");
		expect(html).toContain('class="code-lang"');
		expect(html).toContain("typescript");
	});

	test("omits language label when no lang specified", () => {
		const html = renderMarkdown("```\nconst x = 1;\n```");
		expect(html).not.toContain('class="code-lang"');
	});

	test("includes code-block-header", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```");
		expect(html).toContain('class="code-block-header"');
	});

	test("streaming mode also has copy button", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```", true);
		expect(html).toContain('class="copy-btn"');
		expect(html).toContain('class="code-block-wrapper"');
	});
});

describe("table rendering", () => {
	test("wraps table in table-wrapper div", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain('class="table-wrapper"');
	});

	test("table contains thead and tbody", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<thead>");
		expect(html).toContain("<tbody>");
	});

	test("streaming mode also wraps tables", () => {
		const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", true);
		expect(html).toContain('class="table-wrapper"');
	});

	test("multiple tables in one markdown string", () => {
		const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\nSome text\n\n| c | d |\n|---|---|\n| 3 | 4 |";
		const html = renderMarkdown(md);
		const matches = html.match(/class="table-wrapper"/g);
		expect(matches).toHaveLength(2);
	});
});

describe("renderMarkdown function", () => {
	test("empty string returns empty string", () => {
		expect(renderMarkdown("")).toBe("");
	});

	test("null-ish empty content returns empty string", () => {
		expect(renderMarkdown("" as string)).toBe("");
	});

	test("normal markdown rendering (non-streaming)", () => {
		const html = renderMarkdown("# Hello");
		expect(html).toContain("<h1>");
		expect(html).toContain("Hello");
	});

	test("streaming mode produces structural output", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```", true);
		expect(html).toContain('class="code-block-wrapper"');
		expect(html).toContain('class="copy-btn"');
		expect(html).toContain('class="code-block-header"');
	});

	test("both modes produce same structural elements", () => {
		const md = "```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
		const normal = renderMarkdown(md, false);
		const streaming = renderMarkdown(md, true);
		for (const cls of ["code-block-wrapper", "copy-btn", "table-wrapper", "code-block-header"]) {
			expect(normal).toContain(cls);
			expect(streaming).toContain(cls);
		}
	});

	test("streaming mode does not use hljs highlighting (plain escaped text)", () => {
		const streaming = renderMarkdown("```js\nconst x = 1;\n```", true);
		// hljs would wrap tokens in <span class="hljs-...">; streaming should not
		expect(streaming).not.toContain('class="hljs-');
	});

	test("non-streaming mode uses hljs highlighting", () => {
		const normal = renderMarkdown("```js\nconst x = 1;\n```", false);
		expect(normal).toContain('class="hljs-');
	});
});

describe("makeRenderers - code()", () => {
	test("language class on code element", () => {
		const html = renderMarkdown("```python\nprint('hi')\n```");
		expect(html).toContain('class="language-python"');
	});

	test("no language class when lang not specified", () => {
		const html = renderMarkdown("```\nsome code\n```");
		expect(html).not.toContain('class="language-');
	});

	test("HTML escaping in data-code attribute", () => {
		const html = renderMarkdown('```\nconst x = "<div>" & "hello"\n```');
		expect(html).toContain("data-code=");
		expect(html).toContain("&lt;div&gt;");
		expect(html).toContain("&amp;");
		expect(html).toContain("&quot;");
	});

	test("language label present when lang specified", () => {
		const html = renderMarkdown("```rust\nfn main() {}\n```");
		expect(html).toContain('<span class="code-lang">rust</span>');
	});

	test("language label absent when no lang", () => {
		const html = renderMarkdown("```\nfn main() {}\n```");
		expect(html).not.toContain('class="code-lang"');
	});
});

describe("makeRenderers - table()", () => {
	test("wraps in table-wrapper with thead and tbody", () => {
		const html = renderMarkdown("| h1 | h2 |\n|---|---|\n| r1 | r2 |");
		expect(html).toMatch(/<div class="table-wrapper"><table><thead>.*<\/thead><tbody>.*<\/tbody><\/table><\/div>/s);
	});
});

describe("escapeHtml", () => {
	test("escapes &, <, >, \" in code blocks", () => {
		const html = renderMarkdown('```\nconst x = "<div>" & "hello"\n```');
		// The data-code attribute should have special chars handled
		const dataPart = html.match(/data-code="([^"]*)"/)?.[1] ?? "";
		expect(dataPart).toContain("&amp;");
		expect(dataPart).toContain("&quot;");
		// DOMPurify normalizes entity encoding — < and > may appear literal
		// in attribute values (valid per HTML spec) or as entities
		expect(dataPart).toMatch(/<div>|&lt;div&gt;/);
	});
});

describe("sanitizeInput", () => {
	test("removes script tags", () => {
		const html = renderMarkdown('<script>alert("xss")</script>Hello');
		expect(html).not.toContain("<script");
		expect(html).toContain("Hello");
	});

	test("removes iframe tags", () => {
		const html = renderMarkdown('<iframe src="evil.com"></iframe>Hello');
		expect(html).not.toContain("<iframe");
		expect(html).toContain("Hello");
	});

	test("removes object tags", () => {
		const html = renderMarkdown('<object data="evil.swf"></object>Hello');
		expect(html).not.toContain("<object");
		expect(html).toContain("Hello");
	});

	test("removes embed tags", () => {
		const html = renderMarkdown('<embed src="evil.swf"/>Hello');
		expect(html).not.toContain("<embed");
		expect(html).toContain("Hello");
	});

	test("removes form tags", () => {
		const html = renderMarkdown('<form action="evil.com"><input></form>Hello');
		expect(html).not.toContain("<form");
		expect(html).toContain("Hello");
	});

	test("removes inline event handlers", () => {
		const html = renderMarkdown('<div onclick="alert(1)">test</div>');
		expect(html).not.toContain("onclick");
	});

	test("leaves safe markdown untouched", () => {
		const md = "# Title\n\nA **bold** paragraph with [link](http://example.com)";
		const html = renderMarkdown(md);
		expect(html).toContain("<h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain('href="http://example.com"');
	});
});

describe("styleCitations", () => {
	test("converts [1], [2] to citation-marker spans", () => {
		const html = renderMarkdown("See [1] and [2] for details.");
		expect(html).toContain('<sup class="citation-marker">[1]</sup>');
		expect(html).toContain('<sup class="citation-marker">[2]</sup>');
	});

	test("does NOT convert markdown links [1](url)", () => {
		const html = renderMarkdown("See [1](http://example.com) for details.");
		expect(html).not.toContain("citation-marker");
		expect(html).toContain("href=");
	});

	test("does NOT convert citations inside words/attributes", () => {
		// Preceded by a word character — should not match
		const html = renderMarkdown('word[1] is here');
		expect(html).not.toContain("citation-marker");
	});

	test("does NOT convert citations inside HTML attribute context", () => {
		// When a " precedes [1] in the raw HTML (e.g. inside data-code attribute),
		// the lookbehind prevents matching. In markdown text, quotes get entity-encoded
		// so the lookbehind won't match the entity. This tests the code-block path
		// where data-code="..." contains literal [1].
		const html = renderMarkdown('```\n[1]\n```');
		// Inside data-code="[1]", the quote before [ triggers the lookbehind
		expect(html).toContain('data-code="[1]"');
	});
});

describe("styleMentions", () => {
	test("converts ![ext:name] to purple pill span", () => {
		const html = renderMarkdown("Hello ![ext:markdown-utils] world");
		// Agent/ext/team chips render with the `!` sigil prefix now.
		expect(html).toContain("!markdown-utils</span>");
		expect(html).toContain("rgba(168,85,247,0.3)");
		expect(html).toContain("rgba(168,85,247,0.2)");
		expect(html).toContain("rgb(216,180,254)");
		expect(html).not.toContain("![ext:markdown-utils]");
	});

	test("converts ![agent:name] to blue pill span", () => {
		const html = renderMarkdown("Hello ![agent:Code Assistant] world");
		expect(html).toContain("!Code Assistant</span>");
		expect(html).toContain("rgba(59,130,246,0.3)");
		expect(html).toContain("rgba(59,130,246,0.2)");
		expect(html).toContain("rgb(147,197,253)");
		expect(html).not.toContain("![agent:Code Assistant]");
	});

	test("converts ![team:name] to indigo pill span", () => {
		const html = renderMarkdown("Assign to ![team:QA Team] now");
		expect(html).toContain("!QA Team</span>");
		expect(html).toContain("rgba(99,102,241,0.3)");
		expect(html).toContain("rgba(99,102,241,0.2)");
		expect(html).toContain("rgb(165,180,252)");
	});

	test("converts @[file:path] to green pill with basename", () => {
		const html = renderMarkdown("Edit @[file:src/app.ts] please");
		// File chips render with the `@` sigil and show the basename only.
		expect(html).toContain("@app.ts</span>");
		expect(html).toContain("rgba(34,197,94,0.3)");
		expect(html).toContain("rgba(34,197,94,0.2)");
		expect(html).toContain("rgb(134,239,172)");
		// Full relative path surfaces via tooltip title attribute.
		expect(html).toContain('title="src/app.ts"');
		expect(html).not.toContain("@[file:src/app.ts]");
	});

	test("file at project root shows bare name as both display and tooltip", () => {
		const html = renderMarkdown("Look at @[file:README.md]");
		expect(html).toContain("@README.md</span>");
		expect(html).toContain('title="README.md"');
	});

	test("converts @[dir:path] to amber pill with trailing slash on basename", () => {
		const html = renderMarkdown("Store in @[dir:src/output] please");
		expect(html).toContain("@output/</span>");
		expect(html).toContain("rgba(245,158,11,0.3)");
		expect(html).toContain("rgba(245,158,11,0.2)");
		expect(html).toContain("rgb(252,211,77)");
		expect(html).toContain('title="src/output"');
		expect(html).not.toContain("@[dir:src/output]");
	});

	test("root-level dir shows name/ in pill and full path in tooltip", () => {
		const html = renderMarkdown("inspect @[dir:src]");
		expect(html).toContain("@src/</span>");
		expect(html).toContain('title="src"');
	});

	test("mixed file + dir in one string renders both chips with distinct colors", () => {
		const html = renderMarkdown("read @[file:a.ts] then list @[dir:src]");
		expect(html).toContain("@a.ts</span>");
		expect(html).toContain("@src/</span>");
		expect(html).toContain("rgb(134,239,172)"); // file green
		expect(html).toContain("rgb(252,211,77)"); // dir amber
	});

	test("handles multiple mentions in one string", () => {
		const html = renderMarkdown("Use ![ext:analyzer] and ![agent:Summarizer] together");
		expect(html).toContain("!analyzer</span>");
		expect(html).toContain("!Summarizer</span>");
		expect(html).not.toContain("![ext:analyzer]");
		expect(html).not.toContain("![agent:Summarizer]");
	});

	test("handles mixed !-sigil and @-file mentions in one string", () => {
		const html = renderMarkdown("![agent:Bot] should read @[file:src/x.ts] carefully");
		expect(html).toContain("!Bot</span>");
		expect(html).toContain("@x.ts</span>");
	});

	test("handles mixed mentions and citations", () => {
		const html = renderMarkdown("See ![ext:analyzer] [1] for details");
		expect(html).toContain("!analyzer</span>");
		expect(html).toContain("citation-marker");
	});

	test("escapes special chars in mention names", () => {
		// < and > in mention names get parsed as HTML by marked/DOMPurify
		// before styleMentions runs, so test with chars that survive the pipeline
		const html = renderMarkdown('Hello ![ext:my-tool_v2] world');
		expect(html).toContain("!my-tool_v2</span>");
	});

	test("does not replace unknown mention kinds", () => {
		// MENTION_REGEX only matches agent|ext|team|file, so unknown kinds stay literal.
		const html = renderMarkdown("Hello ![unknown:foo] world");
		expect(html).toContain("![unknown:foo]");
	});

	test("does not replace legacy @[agent:…] tokens (graceful degradation)", () => {
		// Historical messages authored under the old sigil render as plain text.
		const html = renderMarkdown("Hello @[agent:Legacy] world");
		expect(html).toContain("@[agent:Legacy]");
	});

	test("works in streaming mode", () => {
		const html = renderMarkdown("Hello ![ext:test] world", true);
		expect(html).toContain("!test</span>");
		expect(html).not.toContain("![ext:test]");
	});

	test("pill has correct inline styles", () => {
		const html = renderMarkdown("![ext:test]");
		expect(html).toContain("display:inline-flex");
		expect(html).toContain("align-items:center");
		expect(html).toContain("border-radius:9999px");
		expect(html).toContain("font-size:0.75rem");
		expect(html).toContain("font-weight:500");
	});

	test("mention at start of line", () => {
		const html = renderMarkdown("![ext:analyzer] is great");
		expect(html).toContain("!analyzer</span>");
	});

	test("mention at end of line", () => {
		const html = renderMarkdown("try using ![agent:Helper]");
		expect(html).toContain("!Helper</span>");
	});
});

describe("edge cases", () => {
	test("nested code blocks (fenced with different markers)", () => {
		const md = "````\n```\ninner\n```\n````";
		const html = renderMarkdown(md);
		expect(html).toContain('class="code-block-wrapper"');
	});

	test("code with backticks inside", () => {
		const md = "`` `backtick` ``";
		const html = renderMarkdown(md);
		expect(html).toContain("<code>");
		expect(html).toContain("`backtick`");
	});

	test("mixed content: headings + code + tables + lists", () => {
		const md = [
			"# Heading",
			"",
			"- item 1",
			"- item 2",
			"",
			"```js",
			"const x = 1;",
			"```",
			"",
			"| a | b |",
			"|---|---|",
			"| 1 | 2 |",
		].join("\n");
		const html = renderMarkdown(md);
		expect(html).toContain("<h1>");
		expect(html).toContain("<li>");
		expect(html).toContain('class="code-block-wrapper"');
		expect(html).toContain('class="table-wrapper"');
	});
});
