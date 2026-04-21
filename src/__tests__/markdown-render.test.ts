import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "../../web/src/lib/markdown.js";

describe("renderMarkdown", () => {
	test("renders headings", () => {
		const html = renderMarkdown("# Hello World");
		expect(html).toContain("<h1");
		expect(html).toContain("Hello World");
	});

	test("renders bold text", () => {
		const html = renderMarkdown("**bold text**");
		expect(html).toContain("<strong>");
		expect(html).toContain("bold text");
	});

	test("renders unordered lists", () => {
		const html = renderMarkdown("- item 1\n- item 2\n- item 3");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>");
		expect(html).toContain("item 1");
	});

	test("renders ordered lists", () => {
		const html = renderMarkdown("1. first\n2. second");
		expect(html).toContain("<ol>");
		expect(html).toContain("first");
	});

	test("renders code blocks with syntax highlighting", () => {
		const md = '```javascript\nconst x = 42;\n```';
		const html = renderMarkdown(md);
		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("language-javascript");
		// highlight.js adds span tags with classes for syntax coloring
		expect(html).toContain("hljs-");
	});

	test("renders code blocks with auto-detection when no language specified", () => {
		const md = '```\nfunction hello() { return "world"; }\n```';
		const html = renderMarkdown(md);
		expect(html).toContain("<pre>");
		expect(html).toContain("<code>");
	});

	test("renders inline code", () => {
		const html = renderMarkdown("use `console.log()` for debugging");
		expect(html).toContain("<code>");
		expect(html).toContain("console.log()");
	});

	test("renders blockquotes", () => {
		const html = renderMarkdown("> This is a quote");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("This is a quote");
	});

	test("renders nested formatting", () => {
		const html = renderMarkdown("**bold and *italic* text**");
		expect(html).toContain("<strong>");
		expect(html).toContain("<em>");
	});

	// XSS safety tests
	test("strips script tags", () => {
		const html = renderMarkdown('<script>alert("xss")</script>Hello');
		expect(html).not.toContain("<script>");
		expect(html).toContain("Hello");
	});

	test("strips iframe tags", () => {
		const html = renderMarkdown('<iframe src="evil.com"></iframe>Hello');
		expect(html).not.toContain("<iframe");
		expect(html).toContain("Hello");
	});

	test("strips event handlers", () => {
		const html = renderMarkdown('<div onload="alert(1)">content</div>');
		expect(html).not.toContain("onload");
	});

	// Edge cases
	test("handles empty string", () => {
		expect(renderMarkdown("")).toBe("");
	});

	test("handles incomplete code fence (streaming mid-block)", () => {
		const html = renderMarkdown("Here is code:\n```python\ndef hello():");
		// Should still render something without crashing -- content may be wrapped in hljs spans
		expect(html).toContain("hello");
		expect(html).toContain("<pre>");
	});

	test("handles multiple code blocks", () => {
		const md = '```js\nconst a = 1;\n```\n\nSome text\n\n```python\nx = 2\n```';
		const html = renderMarkdown(md);
		expect(html).toContain("language-js");
		expect(html).toContain("language-python");
	});

	test("renders links", () => {
		const html = renderMarkdown("[example](https://example.com)");
		expect(html).toContain("<a");
		expect(html).toContain("https://example.com");
	});
});
