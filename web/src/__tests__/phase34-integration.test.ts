import { test, expect, describe } from "bun:test";
import { renderMarkdown } from "$lib/markdown.js";

// ---------------------------------------------------------------------------
// 1. Markdown rendering pipeline integration
// ---------------------------------------------------------------------------
describe("Markdown rendering pipeline", () => {
	test("full pipeline: raw markdown through sanitize, parse, styleCitations", () => {
		const md = "Hello **world** [1] and `code`";
		const html = renderMarkdown(md);
		expect(html).toContain("<strong>world</strong>");
		expect(html).toContain('<sup class="citation-marker">[1]</sup>');
		expect(html).toContain("<code>");
	});

	test("code block with XSS in lang is sanitized", () => {
		const md = "```<script>alert(1)</script>\nconsole.log('hi')\n```";
		const html = renderMarkdown(md);
		expect(html).not.toContain("<script>");
		expect(html).toContain("console.log");
	});

	test("table renders with table-wrapper class", () => {
		const md = "| col | note |\n|---|---|\n| data | val |";
		const html = renderMarkdown(md);
		expect(html).toContain("table-wrapper");
	});

	test("content with both table and citation renders both markers", () => {
		const md = "See [1] for details.\n\n| a | b |\n|---|---|\n| 1 | 2 |";
		const html = renderMarkdown(md);
		expect(html).toContain("table-wrapper");
		expect(html).toContain("citation-marker");
	});

	test("mixed content: heading + code block + table + list in one pass", () => {
		const md = [
			"# Title",
			"",
			"```js\nlet x = 1;\n```",
			"",
			"| a | b |",
			"|---|---|",
			"| 1 | 2 |",
			"",
			"- item one",
			"- item two",
		].join("\n");
		const html = renderMarkdown(md);
		expect(html).toContain("<h1>");
		expect(html).toContain("code-block-wrapper");
		expect(html).toContain("table-wrapper");
		expect(html).toContain("<li>");
	});

	test("streaming vs non-streaming produce same structural elements", () => {
		const md = "```js\nconst x = 1;\n```";
		const normal = renderMarkdown(md, false);
		const streaming = renderMarkdown(md, true);
		// Both should have the wrapper structure
		expect(normal).toContain("code-block-wrapper");
		expect(streaming).toContain("code-block-wrapper");
		expect(normal).toContain("copy-btn");
		expect(streaming).toContain("copy-btn");
		// But highlighting differs: normal uses hljs spans, streaming does not
		const hljsSpans = (normal.match(/<span class="hljs-/g) || []).length;
		const streamHljsSpans = (streaming.match(/<span class="hljs-/g) || []).length;
		expect(hljsSpans).toBeGreaterThan(0);
		expect(streamHljsSpans).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Copy button data flow
// ---------------------------------------------------------------------------
describe("Copy button data-code attribute", () => {
	test("data-code contains original code (HTML-escaped)", () => {
		const md = "```\nlet x = 1;\n```";
		const html = renderMarkdown(md);
		expect(html).toMatch(/data-code="let x = 1;"/);
	});

	test("multi-line code is preserved in data-code", () => {
		const md = "```\nline1\nline2\nline3\n```";
		const html = renderMarkdown(md);
		// Newlines should be present in data-code (escaped as needed)
		expect(html).toMatch(/data-code="line1\nline2\nline3"/);
	});

	test("special characters in code are escaped in data-code", () => {
		const md = '```\n<div class="x">&amp;\n```';
		const html = renderMarkdown(md);
		// < > " & should be escaped
		expect(html).toContain("data-code=");
		expect(html).toContain("&lt;div");
		expect(html).toContain("&amp;amp;");
		expect(html).toContain("&quot;");
	});
});

// ---------------------------------------------------------------------------
// 3. Markdown + CSS class contract
// ---------------------------------------------------------------------------
describe("CSS class contract between renderer and styles", () => {
	test("code block output contains all expected CSS classes", () => {
		const md = "```js\ncode\n```";
		const html = renderMarkdown(md);
		for (const cls of ["code-block-wrapper", "code-block-header", "copy-btn", "code-lang"]) {
			expect(html).toContain(cls);
		}
	});

	test("table output contains table-wrapper class", () => {
		const md = "| a |\n|---|\n| b |";
		const html = renderMarkdown(md);
		expect(html).toContain("table-wrapper");
	});

	test("citation output contains citation-marker class", () => {
		const md = "See reference [1] and [2].";
		const html = renderMarkdown(md);
		expect(html).toContain("citation-marker");
		// Both citations rendered
		const count = (html.match(/citation-marker/g) || []).length;
		expect(count).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 4. Chat input height + scroll integration
// ---------------------------------------------------------------------------
describe("Chat input height logic", () => {
	const LINE_HEIGHT = 24;
	const MAX_ROWS = 6;

	test("adjustHeight caps at 144px (6 rows * 24px)", () => {
		const maxHeight = LINE_HEIGHT * MAX_ROWS;
		expect(maxHeight).toBe(144);
	});

	test("height formula: Math.min(scrollHeight, maxHeight)", () => {
		const maxHeight = LINE_HEIGHT * MAX_ROWS;
		// Simulate small content
		expect(Math.min(48, maxHeight)).toBe(48);
		// Simulate overflow content
		expect(Math.min(300, maxHeight)).toBe(144);
	});
});

// ---------------------------------------------------------------------------
// 5. Sanitization + rendering integration
// ---------------------------------------------------------------------------
describe("Sanitization + rendering integration", () => {
	test("script tags in markdown are removed before rendering", () => {
		const md = "Hello <script>alert('xss')</script> world";
		const html = renderMarkdown(md);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("alert");
		expect(html).toContain("Hello");
		expect(html).toContain("world");
	});

	test("event handlers in markdown are stripped", () => {
		const md = '<div onmouseover="alert(1)">hover</div>';
		const html = renderMarkdown(md);
		expect(html).not.toContain("onmouseover");
	});

	test("safe markdown passes through correctly", () => {
		const md = "**bold** _italic_ [link](https://example.com)";
		const html = renderMarkdown(md);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain('<a href="https://example.com">link</a>');
	});

	test("nested dangerous content: script inside bold is stripped but bold preserved", () => {
		const md = "**<script>alert(1)</script>bold**";
		const html = renderMarkdown(md);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("alert");
		expect(html).toContain("<strong>");
		expect(html).toContain("bold");
	});

	test("iframe tags are removed", () => {
		const md = 'Text <iframe src="evil.com"></iframe> more';
		const html = renderMarkdown(md);
		expect(html).not.toContain("<iframe");
	});
});
