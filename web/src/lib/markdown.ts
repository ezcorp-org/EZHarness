import { Marked } from "marked";
import hljs from "highlight.js";
import { html as diff2htmlRender, parse as diff2htmlParse } from "diff2html";
import DOMPurify from "isomorphic-dompurify";
import { MENTION_REGEX } from "./mention-logic";

const DOMPURIFY_CONFIG = {
	ALLOWED_TAGS: [
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
		'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'span',
		'em', 'strong', 'del', 'a', 'img', 'table', 'thead',
		'tbody', 'tr', 'th', 'td', 'div', 'sup', 'sub', 'details', 'summary',
		'button',
	],
	ALLOWED_ATTR: [
		'href', 'src', 'alt', 'title', 'class', 'id', 'target',
		'rel', 'data-mention', 'data-citation', 'colspan', 'rowspan',
		'data-code', 'data-view', 'data-expanded', 'style',
	],
	ALLOW_DATA_ATTR: true,
};

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m;

/** Detect whether a code block contains diff content */
export function isDiffBlock(text: string, lang?: string): boolean {
	if (lang === "diff") return true;
	if (!lang || lang === "") return HUNK_HEADER_RE.test(text);
	return false;
}

/** Render diff text as dual-view HTML (side-by-side + unified) with file headers */
function renderDiffBlock(text: string): string {
	const parsed = diff2htmlParse(text);

	const sideBySideHtml = diff2htmlRender(text, { outputFormat: "side-by-side", drawFileList: false, matching: "lines" });
	const unifiedHtml = diff2htmlRender(text, { outputFormat: "line-by-line", drawFileList: false, matching: "lines" });

	const files = parsed.length > 0 ? parsed : [{ oldName: "unknown file", newName: "unknown file", addedLines: 0, deletedLines: 0 }];

	const fileHeaders = files.map((f, i) => {
		const name = f.newName !== "/dev/null" ? f.newName : f.oldName;
		const expanded = i === 0;
		return `<div class="diff-file-section" data-expanded="${expanded}"><button class="diff-file-toggle">${escapeHtml(name)} <span class="diff-additions">+${f.addedLines}</span> <span class="diff-deletions">-${f.deletedLines}</span></button><div class="diff-file-body"${expanded ? "" : ' style="display:none"'}></div></div>`;
	}).join("");

	return `<div class="diff-container" data-view="side-by-side"><div class="diff-header"><button class="diff-toggle-btn">Unified</button></div>${fileHeaders}<div class="diff-view-side">${sideBySideHtml}</div><div class="diff-view-unified" style="display:none">${unifiedHtml}</div></div>`;
}

function makeRenderers(highlightFn: (text: string, lang?: string) => string, enableDiffRendering = false) {
	return {
		code({ text, lang }: { text: string; lang?: string }) {
			if (enableDiffRendering && isDiffBlock(text, lang)) {
				return renderDiffBlock(text);
			}
			const highlighted = highlightFn(text, lang);
			const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
			const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
			return `<div class="code-block-wrapper"><div class="code-block-header">${langLabel}<button class="copy-btn" data-code="${escapeHtml(text)}">Copy</button></div><pre><code${langClass}>${highlighted}</code></pre></div>`;
		},
		table({ header, rows, align }: { header: { text: string }[]; rows: { text: string }[][]; align: (string | null)[] }) {
			const thCells = header.map((cell, i) => {
				const a = align[i] ? ` style="text-align:${align[i]}"` : "";
				return `<th${a}>${escapeHtml(cell.text)}</th>`;
			}).join("");
			const bodyRows = rows.map(row =>
				"<tr>" + row.map((cell, i) => {
					const a = align[i] ? ` style="text-align:${align[i]}"` : "";
					return `<td${a}>${escapeHtml(cell.text)}</td>`;
				}).join("") + "</tr>"
			).join("");
			return `<div class="table-wrapper"><table><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
		},
	};
}

const marked = new Marked({
	renderer: makeRenderers((text, lang) => {
		if (lang && hljs.getLanguage(lang)) {
			return hljs.highlight(text, { language: lang }).value;
		}
		return hljs.highlightAuto(text).value;
	}, true),
	async: false,
});

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Style citation markers like [1], [2] as superscript blue text */
function styleCitations(html: string): string {
	// Match [N] patterns not inside <a> tags or markdown link syntax
	// Only match standalone [digit] not followed by ( which would be a markdown link
	return html.replace(
		/(?<!["\w])\[(\d{1,2})\](?!\()/g,
		'<sup class="citation-marker">[$1]</sup>',
	);
}

const MENTION_COLORS = {
	ext: { border: "rgba(168,85,247,0.3)", bg: "rgba(168,85,247,0.2)", text: "rgb(216,180,254)" },
	agent: { border: "rgba(59,130,246,0.3)", bg: "rgba(59,130,246,0.2)", text: "rgb(147,197,253)" },
	team: { border: "rgba(99,102,241,0.3)", bg: "rgba(99,102,241,0.2)", text: "rgb(165,180,252)" },
	file: { border: "rgba(34,197,94,0.3)", bg: "rgba(34,197,94,0.2)", text: "rgb(134,239,172)" },
	dir: { border: "rgba(245,158,11,0.3)", bg: "rgba(245,158,11,0.2)", text: "rgb(252,211,77)" },
	cmd: { border: "rgba(236,72,153,0.3)", bg: "rgba(236,72,153,0.2)", text: "rgb(249,168,212)" },
} as const;

/**
 * Replace structured mention tokens with inline-styled pill spans.
 * Handles three sigils:
 *   ![agent|ext|team:name]   (group 1 = kind, group 2 = name) — rendered with !
 *   @[file|dir:path]         (group 3 = kind, group 4 = name) — rendered with @
 *                            (file shows basename; dir shows basename + trailing "/")
 *   /[cmd:name]              (group 5 = kind, group 6 = name) — rendered with /
 */
function styleMentions(html: string): string {
	return html.replace(
		new RegExp(MENTION_REGEX.source, "g"),
		(
			match,
			bangKind: string | undefined,
			bangName: string | undefined,
			pathKind: string | undefined,
			pathName: string | undefined,
			slashKind: string | undefined,
			slashName: string | undefined,
		) => {
			let kind: keyof typeof MENTION_COLORS;
			let displayName: string;
			let sigil: "!" | "@" | "/";
			let fullPath: string | undefined;
			if (bangKind !== undefined) {
				kind = bangKind as keyof typeof MENTION_COLORS;
				displayName = bangName!;
				sigil = "!";
			} else if (pathKind !== undefined) {
				kind = pathKind as "file" | "dir";
				// Show the basename in the pill (full path available via tooltip/title).
				const slash = pathName!.lastIndexOf("/");
				const base = slash >= 0 ? pathName!.slice(slash + 1) : pathName!;
				displayName = kind === "dir" ? `${base}/` : base;
				sigil = "@";
				fullPath = pathName!;
			} else if (slashKind !== undefined) {
				kind = slashKind as "cmd";
				displayName = slashName!;
				sigil = "/";
			} else {
				return match;
			}
			const c = MENTION_COLORS[kind];
			if (!c) return match;
			const title = fullPath !== undefined ? ` title="${escapeHtml(fullPath)}"` : "";
			return `<span${title} style="display:inline-flex;align-items:center;border-radius:9999px;border:1px solid ${c.border};background:${c.bg};color:${c.text};padding:0.125rem 0.375rem;font-size:0.75rem;font-weight:500">${sigil}${escapeHtml(displayName)}</span>`;
		},
	);
}

/** Streaming-optimized Marked instance: skips expensive hljs highlighting and diff rendering */
const streamingMarked = new Marked({
	renderer: makeRenderers((text) => escapeHtml(text), false),
	async: false,
});

export function renderMarkdown(content: string, streaming = false): string {
	if (!content) return "";
	const parser = streaming ? streamingMarked : marked;
	const rawHtml = parser.parse(content) as string;
	const sanitized = DOMPurify.sanitize(rawHtml, DOMPURIFY_CONFIG);
	return styleMentions(styleCitations(sanitized));
}
