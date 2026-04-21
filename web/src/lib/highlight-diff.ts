import hljs from "highlight.js";

/**
 * Map diff2html's file extension (stored on `.d2h-file-wrapper[data-lang]`)
 * to a highlight.js language name. Covers the common cases we care about;
 * anything unknown falls through to hljs auto-detection.
 */
const EXT_TO_HLJS: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	json: "json",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	md: "markdown",
	markdown: "markdown",
	html: "xml",
	xml: "xml",
	svg: "xml",
	svelte: "xml",
	vue: "xml",
	css: "css",
	scss: "scss",
	sql: "sql",
	dockerfile: "dockerfile",
	makefile: "makefile",
};

function resolveHljsLang(raw: string | null): string | undefined {
	if (!raw) return undefined;
	const lower = raw.toLowerCase();
	const mapped = EXT_TO_HLJS[lower];
	if (mapped && hljs.getLanguage(mapped)) return mapped;
	if (hljs.getLanguage(lower)) return lower;
	return undefined;
}

/**
 * Apply highlight.js syntax highlighting to rendered diff2html content
 * living inside `element`. Re-reads `textContent` from each code line so
 * it's safe (and idempotent) to call multiple times.
 *
 * Reuses the same `hljs` instance that the chat markdown renderer uses,
 * and relies on the shared theme in `hljs-theme.css` for colors.
 */
export function highlightDiff(element: HTMLElement): void {
	const files = element.querySelectorAll<HTMLElement>(".d2h-file-wrapper");
	if (files.length === 0) return;

	for (const file of files) {
		const lang = resolveHljsLang(file.getAttribute("data-lang"));
		const lines = file.querySelectorAll<HTMLElement>(".d2h-code-line-ctn");
		for (const line of lines) {
			const text = line.textContent ?? "";
			if (!text.trim()) continue;
			try {
				const result = lang
					? hljs.highlight(text, { language: lang, ignoreIllegals: true })
					: hljs.highlightAuto(text);
				line.classList.add("hljs");
				if (result.language) line.classList.add(result.language);
				line.innerHTML = result.value;
			} catch {
				// Best-effort — leave the line untouched on any hljs failure.
			}
		}
	}
}
