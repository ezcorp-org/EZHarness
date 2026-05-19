import { test, expect, describe } from "bun:test";
import { renderMarkdown, isDiffBlock, isSafeImageSrc } from "../markdown";

describe("renderMarkdown", () => {
	test("returns empty string for empty content", () => {
		expect(renderMarkdown("")).toBe("");
		expect(renderMarkdown("", true)).toBe("");
	});

	test("renders basic markdown", () => {
		const html = renderMarkdown("**bold** text");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("text");
	});

	test("renders code blocks with syntax highlighting in non-streaming mode", () => {
		const code = "```js\nconst x = 1;\n```";
		const html = renderMarkdown(code, false);
		// hljs adds class spans for syntax highlighting
		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("hljs");
	});

	test("renders code blocks WITHOUT syntax highlighting in streaming mode", () => {
		const code = "```js\nconst x = 1;\n```";
		const html = renderMarkdown(code, true);
		expect(html).toContain("<pre>");
		expect(html).toContain("<code");
		expect(html).toContain("language-js");
		// Should NOT contain hljs classes — just escaped plain text
		expect(html).not.toContain("hljs");
	});

	test("streaming mode escapes HTML entities in code blocks", () => {
		const code = '```html\n<div class="test">&amp;</div>\n```';
		const html = renderMarkdown(code, true);
		expect(html).toContain("&lt;div");
		expect(html).toContain("&amp;amp;");
	});

	test("non-streaming mode renders code blocks with hljs spans", () => {
		const code = '```html\n<div class="test">&amp;</div>\n```';
		const html = renderMarkdown(code, false);
		// hljs wraps tokens in <span> elements with class names
		expect(html).toContain("hljs");
		expect(html).toContain("&amp;amp;");
	});

	test("sanitizes script tags before rendering in both modes", () => {
		const md = '<script>alert("xss")</script>safe text';
		expect(renderMarkdown(md, false)).not.toContain("<script>");
		expect(renderMarkdown(md, true)).not.toContain("<script>");
		expect(renderMarkdown(md, false)).toContain("safe text");
		expect(renderMarkdown(md, true)).toContain("safe text");
	});

	test("streaming mode renders inline markdown correctly", () => {
		const md = "Here is `inline code` and *italic*";
		const html = renderMarkdown(md, true);
		expect(html).toContain("<code>");
		expect(html).toContain("<em>italic</em>");
	});

	test("streaming and non-streaming produce same structure for plain text", () => {
		const md = "Hello, this is a plain paragraph.";
		const streamingHtml = renderMarkdown(md, true);
		const normalHtml = renderMarkdown(md, false);
		// Both should produce the same output for text without code blocks
		expect(streamingHtml).toBe(normalHtml);
	});

	test("citation markers are styled in both modes", () => {
		const md = "See reference [1] and [2].";
		const streamingHtml = renderMarkdown(md, true);
		const normalHtml = renderMarkdown(md, false);
		expect(streamingHtml).toContain("citation-marker");
		expect(normalHtml).toContain("citation-marker");
	});

	test("sanitizes script tags in both modes", () => {
		const md = '<script>alert("xss")</script>Hello';
		expect(renderMarkdown(md, false)).not.toContain("<script>");
		expect(renderMarkdown(md, true)).not.toContain("<script>");
	});

	test("code block without language uses highlightAuto in non-streaming", () => {
		const code = "```\nconst x = 1;\n```";
		const html = renderMarkdown(code, false);
		expect(html).toContain("<pre>");
		// hljs.highlightAuto should still produce highlighted output
		expect(html).toContain("<code");
	});

	test("code block without language skips highlighting in streaming", () => {
		const code = "```\nconst x = 1;\n```";
		const html = renderMarkdown(code, true);
		expect(html).toContain("<pre>");
		expect(html).not.toContain("hljs");
	});

	test("streaming defaults to false", () => {
		const code = "```js\nlet y = 2;\n```";
		const defaultHtml = renderMarkdown(code);
		const explicitHtml = renderMarkdown(code, false);
		expect(defaultHtml).toBe(explicitHtml);
	});
});

describe("diff rendering", () => {
	const SIMPLE_DIFF = "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;";
	const MULTI_FILE_DIFF = "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;\n--- a/bar.ts\n+++ b/bar.ts\n@@ -1,2 +1,3 @@\n let a = 1;\n+let b = 2;\n let c = 3;";
	const HEADERLESS_DIFF = "@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;";

	// Detection tests
	test("isDiffBlock returns true for lang=diff", () => {
		expect(isDiffBlock("anything", "diff")).toBe(true);
	});

	test("isDiffBlock auto-detects @@ hunk headers with no lang", () => {
		expect(isDiffBlock("@@ -1,3 +1,4 @@\nsome content", undefined)).toBe(true);
	});

	test("isDiffBlock returns false for lang=js", () => {
		expect(isDiffBlock("normal code", "js")).toBe(false);
	});

	test("isDiffBlock returns false for plain text with no lang", () => {
		expect(isDiffBlock("normal code without hunk headers", undefined)).toBe(false);
	});

	// Rendering pipeline tests
	test("```diff fence produces diff-container HTML", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain("diff-container");
	});

	test("unlabeled block with @@ produces diff-container HTML", () => {
		const html = renderMarkdown("```\n" + HEADERLESS_DIFF + "\n```");
		expect(html).toContain("diff-container");
	});

	test("streaming mode produces plain code block for diff", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```", true);
		expect(html).not.toContain("diff-container");
		expect(html).toContain("code-block-wrapper");
	});

	test("multi-file diff produces multiple diff-file sections, first expanded", () => {
		const html = renderMarkdown("```diff\n" + MULTI_FILE_DIFF + "\n```");
		const sections = html.match(/diff-file-section/g);
		expect(sections).not.toBeNull();
		expect(sections!.length).toBeGreaterThanOrEqual(2);
		expect(html).toContain('data-expanded="true"');
		expect(html).toContain('data-expanded="false"');
	});

	test("diff output contains diff-toggle-btn", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain("diff-toggle-btn");
	});

	test("diff output contains diff-additions and diff-deletions spans with counts", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain("diff-additions");
		expect(html).toContain("diff-deletions");
	});

	test("diff with <script> in content does NOT produce unescaped script tags", () => {
		const xssDiff = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-safe\n+<script>alert("xss")</script>';
		const html = renderMarkdown("```diff\n" + xssDiff + "\n```");
		expect(html).not.toContain("<script>");
	});

	test("diff without file headers (just @@ hunks) renders as unknown file fallback", () => {
		const html = renderMarkdown("```\n" + HEADERLESS_DIFF + "\n```");
		expect(html).toContain("diff-container");
		expect(html).toContain("diff-file-section");
	});

	// Additional unit tests for edge cases
	test("isDiffBlock returns false for empty string with no lang", () => {
		expect(isDiffBlock("", undefined)).toBe(false);
	});

	test("isDiffBlock returns false for whitespace-only text with no lang", () => {
		expect(isDiffBlock("   \n\n  ", undefined)).toBe(false);
	});

	test("isDiffBlock returns true for lang=diff even with empty text", () => {
		expect(isDiffBlock("", "diff")).toBe(true);
	});

	test("isDiffBlock returns false for text with @@ inside a string (not at line start)", () => {
		expect(isDiffBlock('const x = "@@ -1,3 +1,4 @@"', undefined)).toBe(false);
	});

	test("diff with deleted file (/dev/null) renders file header from old name", () => {
		const deletedDiff = "--- a/removed.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const x = 1;\n-const y = 2;";
		const html = renderMarkdown("```diff\n" + deletedDiff + "\n```");
		expect(html).toContain("diff-container");
		expect(html).toContain("removed.ts");
	});

	test("diff with only additions (new file) renders correctly", () => {
		const newFileDiff = "--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1,3 @@\n+const a = 1;\n+const b = 2;\n+const c = 3;";
		const html = renderMarkdown("```diff\n" + newFileDiff + "\n```");
		expect(html).toContain("diff-container");
		expect(html).toContain("new-file.ts");
		expect(html).toContain("+3");
		expect(html).toContain("-0");
	});

	test("diff with only deletions renders correctly", () => {
		const delOnlyDiff = "--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line1\n-line2";
		const html = renderMarkdown("```diff\n" + delOnlyDiff + "\n```");
		expect(html).toContain("diff-deletions");
	});

	test("diff with special characters in filename is HTML-escaped", () => {
		const specialDiff = '--- a/src/<script>.ts\n+++ b/src/<script>.ts\n@@ -1,2 +1,2 @@\n-old\n+new';
		const html = renderMarkdown("```diff\n" + specialDiff + "\n```");
		expect(html).not.toContain("<script>.ts");
		expect(html).toContain("&lt;script&gt;");
	});

	test("multiple diff blocks in one message each get their own container", () => {
		const md = "First diff:\n```diff\n" + SIMPLE_DIFF + "\n```\nSecond diff:\n```diff\n" + SIMPLE_DIFF + "\n```";
		const html = renderMarkdown(md);
		const containers = html.match(/diff-container/g);
		expect(containers).not.toBeNull();
		expect(containers!.length).toBeGreaterThanOrEqual(2);
	});

	test("diff block coexists with regular code block", () => {
		const md = "```js\nconst x = 1;\n```\n\n```diff\n" + SIMPLE_DIFF + "\n```";
		const html = renderMarkdown(md);
		expect(html).toContain("code-block-wrapper");
		expect(html).toContain("diff-container");
	});

	test("diff renders both side-by-side and unified views", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain("diff-view-side");
		expect(html).toContain("diff-view-unified");
	});

	test("unified view is initially hidden", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain('class="diff-view-unified" style="display:none"');
	});

	test("isDiffBlock returns true for empty lang string with hunk headers", () => {
		expect(isDiffBlock("@@ -1,3 +1,4 @@\nsome content", "")).toBe(true);
	});

	test("isDiffBlock returns false for empty lang string without hunk headers", () => {
		expect(isDiffBlock("just plain text", "")).toBe(false);
	});

	test("diff default data-view attribute is side-by-side", () => {
		const html = renderMarkdown("```diff\n" + SIMPLE_DIFF + "\n```");
		expect(html).toContain('data-view="side-by-side"');
	});

	test("diff with rename header renders correctly", () => {
		const renameDiff = "--- a/old-name.ts\n+++ b/new-name.ts\n@@ -1,2 +1,2 @@\n-old\n+new";
		const html = renderMarkdown("```diff\n" + renameDiff + "\n```");
		expect(html).toContain("diff-container");
		expect(html).toContain("new-name.ts");
	});

	test("diff with context-only lines (no additions/deletions) renders", () => {
		const contextOnly = "--- a/ctx.ts\n+++ b/ctx.ts\n@@ -1,2 +1,2 @@\n context line 1\n context line 2";
		const html = renderMarkdown("```diff\n" + contextOnly + "\n```");
		expect(html).toContain("diff-container");
		expect(html).toContain("+0");
		expect(html).toContain("-0");
	});

	test("diff with many hunks in single file renders one file section", () => {
		const multiHunk = "--- a/big.ts\n+++ b/big.ts\n@@ -1,2 +1,3 @@\n line1\n+added1\n line2\n@@ -10,2 +11,3 @@\n line10\n+added2\n line11";
		const html = renderMarkdown("```diff\n" + multiHunk + "\n```");
		const sections = html.match(/diff-file-section/g);
		expect(sections).not.toBeNull();
		expect(sections!.length).toBe(1);
	});

	test("diff with HTML entities in code content escapes them", () => {
		const htmlDiff = "--- a/tmpl.html\n+++ b/tmpl.html\n@@ -1,2 +1,2 @@\n-<div>&old</div>\n+<div>&new</div>";
		const html = renderMarkdown("```diff\n" + htmlDiff + "\n```");
		expect(html).not.toContain("&old</div>");
		expect(html).toContain("diff-container");
	});

	test("lang=javascript with @@ in content does NOT render as diff", () => {
		const code = 'const x = "@@ -1,3 +1,4 @@";';
		const html = renderMarkdown("```javascript\n" + code + "\n```");
		expect(html).not.toContain("diff-container");
		expect(html).toContain("code-block-wrapper");
	});
});

describe("isSafeImageSrc", () => {
	test("accepts https urls", () => {
		expect(isSafeImageSrc("https://example.com/x.png")).toBe(true);
	});
	test("accepts http urls", () => {
		expect(isSafeImageSrc("http://example.com/x.png")).toBe(true);
	});
	test("accepts data: image URIs", () => {
		expect(isSafeImageSrc("data:image/png;base64,iVBOR")).toBe(true);
	});
	test("accepts blob: URIs", () => {
		expect(isSafeImageSrc("blob:https://example.com/xyz")).toBe(true);
	});
	test("accepts absolute path /foo.png", () => {
		expect(isSafeImageSrc("/foo.png")).toBe(true);
	});
	test("rejects protocol-relative urls", () => {
		expect(isSafeImageSrc("//example.com/x.png")).toBe(false);
	});
	test("rejects javascript: URIs", () => {
		expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
	});
	test("rejects file: URIs", () => {
		expect(isSafeImageSrc("file:///etc/passwd")).toBe(false);
	});
	test("rejects data: non-image URIs", () => {
		expect(isSafeImageSrc("data:text/html,<script>alert(1)</script>")).toBe(false);
	});
	test("rejects empty and whitespace", () => {
		expect(isSafeImageSrc("")).toBe(false);
		expect(isSafeImageSrc("   ")).toBe(false);
	});
	test("rejects malformed / non-URL strings", () => {
		// URL() throws for bare identifiers without a scheme; we catch and reject.
		expect(isSafeImageSrc("not a url")).toBe(false);
		expect(isSafeImageSrc("http://")).toBe(false);
		expect(isSafeImageSrc("abc")).toBe(false);
	});
});

describe("markdown image rendering", () => {
	test("https image renders as <img> with chat-image marker and lazy loading", () => {
		const html = renderMarkdown("![a cat](https://example.com/cat.png)");
		expect(html).toContain('data-chat-image="1"');
		expect(html).toContain('loading="lazy"');
		expect(html).toContain('decoding="async"');
		expect(html).toContain('src="https://example.com/cat.png"');
		expect(html).toContain('alt="a cat"');
		expect(html).toContain('data-original-url="https://example.com/cat.png"');
		expect(html).toContain('class="chat-image progressive-img"');
		expect(html).toContain('referrerpolicy="no-referrer"');
		// Wrapped for blur-in loading (shimmer placeholder + clip).
		expect(html).toContain('class="progressive-img-wrap"');
	});

	test("data:image URI renders as <img>", () => {
		const html = renderMarkdown("![](data:image/png;base64,AAA)");
		expect(html).toContain('data-chat-image="1"');
		expect(html).toContain("data:image/png;base64,AAA");
	});

	test("javascript: URI is NOT rendered as <img>", () => {
		const html = renderMarkdown("![x](javascript:alert(1))");
		// Must not produce an <img> element whose src is the javascript: URI.
		expect(html).not.toMatch(/<img[^>]*src="javascript:/i);
	});

	test("file: URI is NOT rendered as <img>", () => {
		const html = renderMarkdown("![x](file:///etc/passwd)");
		expect(html).not.toMatch(/<img[^>]*src="file:/i);
	});

	test("image title attribute is preserved", () => {
		const html = renderMarkdown('![alt](https://example.com/x.png "hover text")');
		expect(html).toContain('title="hover text"');
	});

	test("image alt text cannot escape the attribute to inject a script tag", () => {
		const html = renderMarkdown('![<script>alert(1)</script>](https://example.com/x.png)');
		// No live <script> element — angle brackets inside attr values are legal
		// HTML and harmless; only a tag-level <script>...</script> matters.
		expect(html).not.toMatch(/<script[\s>]/i);
	});

	test("image href double-quote is encoded so it cannot close the src attribute", () => {
		const html = renderMarkdown('![x](https://example.com/x.png"onerror="alert(1))');
		// The raw `"` inside the URL must be HTML-encoded inside the src attr so it
		// cannot terminate the attribute value and inject `onerror=`.
		const imgTag = html.match(/<img[^>]*>/i)?.[0] ?? "";
		expect(imgTag).not.toContain('onerror="alert');
		expect(imgTag).toMatch(/src="[^"]*"/);
	});

	test("no image in markdown → no <img> in output", () => {
		const html = renderMarkdown("just some text");
		expect(html).not.toContain("<img");
	});

	test("image works inside paragraph with surrounding text", () => {
		const html = renderMarkdown("Here is ![cat](https://example.com/c.png) a cat.");
		expect(html).toContain("<img");
		expect(html).toContain("a cat.");
	});

	test("DOMPurify preserves loading, decoding, referrerpolicy on <img>", () => {
		const html = renderMarkdown("![](https://example.com/x.png)");
		expect(html).toMatch(/loading="lazy"/);
		expect(html).toMatch(/decoding="async"/);
		expect(html).toMatch(/referrerpolicy="no-referrer"/);
	});
});

describe("table rendering", () => {
	const TABLE_MD = "| Name | Age |\n| --- | ---:|\n| Alice | 30 |\n| Bob | 25 |";

	test("renders a table with thead/tbody/tr/th/td", () => {
		const html = renderMarkdown(TABLE_MD);
		expect(html).toContain("table-wrapper");
		expect(html).toContain("<thead>");
		expect(html).toContain("<tbody>");
		expect(html).toContain("<th");
		expect(html).toContain("<td");
		expect(html).toContain("Alice");
		expect(html).toContain("Bob");
	});

	test("preserves column alignment via inline style", () => {
		const html = renderMarkdown(TABLE_MD);
		expect(html).toContain('style="text-align:right"');
	});

	test("escapes HTML in table cells", () => {
		const unsafe = "| A | B |\n| --- | --- |\n| <script>alert(1)</script> | x |";
		const html = renderMarkdown(unsafe);
		expect(html).not.toMatch(/<script[\s>]/i);
	});
});

describe("mention pill rendering", () => {
	test("renders agent mention as pill span", () => {
		const html = renderMarkdown("hey ![agent:my-agent] how are you");
		expect(html).toContain("!my-agent");
		expect(html).toMatch(/display:inline-flex/);
	});

	test("renders file mention as pill span showing basename", () => {
		const html = renderMarkdown("see @[file:src/foo/bar.ts]");
		// basename only in the pill display
		expect(html).toContain("bar.ts");
		expect(html).toMatch(/title="src\/foo\/bar\.ts"/);
	});

	test("renders dir mention as pill with trailing slash", () => {
		const html = renderMarkdown("in @[dir:src/foo]");
		expect(html).toContain("foo/");
	});

	test("renders slash-command mention as pill", () => {
		const html = renderMarkdown("run /[cmd:init] now");
		expect(html).toContain("/init");
	});

	test("renders ext mention as pill", () => {
		const html = renderMarkdown("with ![ext:my-ext]");
		expect(html).toContain("!my-ext");
	});

	test("renders team mention as pill", () => {
		const html = renderMarkdown("with ![team:t1]");
		expect(html).toContain("!t1");
	});

	test("file mention without directory shows raw name", () => {
		const html = renderMarkdown("see @[file:foo.ts]");
		expect(html).toContain("foo.ts");
	});
});
