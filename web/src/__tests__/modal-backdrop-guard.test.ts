/**
 * Guard: every full-viewport backdrop is `ModalBackdrop`.
 *
 * Twenty-six backdrops each carried their own full-viewport fixed box: 21 as a `fixed inset-0` class list, 5 as a
 * scoped `<style>` rule. Inside a `space-y-*` stack, Tailwind's spacing gave such a box a bottom margin, and a fixed
 * box with `inset: 0` and a margin stops short of the viewport edge: the status bar strip stayed bright and clickable
 * under an open modal. `web/src/lib/components/ui/ModalBackdrop.svelte` is now the one backdrop, and it cannot take a
 * margin. This test reads every .svelte file under web/src and fails, anywhere else, on:
 *   - a class list that holds both `fixed` and `inset-0`;
 *   - a scoped CSS rule that pins a box to all four edges (`inset: 0`, or `top`, `right`, `bottom` and `left` all 0)
 *     and is `position: fixed`, or sets no position in a file that has a `position: fixed` rule (a modifier class
 *     such as `.dock-host-mobile` pins the box that `.dock-host` fixes).
 * A full-viewport box that is not a backdrop needs an entry in ALLOWED with its reason. An entry that no longer
 * matches fails too, so the list cannot rot.
 */
import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";

const WEB_SRC = join(import.meta.dir, "..");
const BACKDROP = "lib/components/ui/ModalBackdrop.svelte";

/** Reviewed full-viewport boxes that are not backdrops: file (relative to web/src), the CSS selector, and why. */
const ALLOWED: ReadonlyArray<{ file: string; selector: string; reason: string }> = [
	{
		file: "lib/factory/FactoryArtifactPreview.svelte",
		selector: ".preview-backdrop",
		reason: "Preview layer, not backdrop: the artifact preview is the page itself while it is open.",
	},
	{
		file: "lib/components/tool-cards/DockHost.svelte",
		selector: ".dock-host-mobile",
		reason: "Panel, not backdrop: on a phone the dock is a full-screen panel with its own header and content.",
	},
];

type Hit = { line: number; what: string };

/** Each class list in a Svelte source (`class="…"`, `class='…'`, ``class={`…`}``) that pins a fixed box to all edges. */
function rawBackdrops(source: string): Hit[] {
	const hits: Hit[] = [];
	for (const match of source.matchAll(/\bclass=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
		const classes = match[1] ?? match[2] ?? match[3] ?? "";
		const tokens = classes.split(/\s+/);
		if (tokens.includes("fixed") && tokens.includes("inset-0")) {
			hits.push({ line: source.slice(0, match.index).split("\n").length, what: classes.trim() });
		}
	}
	return hits;
}

const ZERO = /^0(px|rem|em|%)?$/;

/** Each scoped `<style>` rule that pins a fixed box to all four edges; `what` is the rule's selector. */
function rawCssBackdrops(source: string): Hit[] {
	const hits: Hit[] = [];
	for (const style of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
		const css = (style[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
		const offset = (style.index ?? 0) + style[0].indexOf(">") + 1;
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => {
			const declarations = new Map<string, string>();
			for (const declaration of (rule[2] ?? "").split(";")) {
				const colon = declaration.indexOf(":");
				if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
			}
			const head = rule[1] ?? "";
			return { selector: head.trim(), declarations, index: offset + (rule.index ?? 0) + head.length - head.trimStart().length };
		});
		const fileFixes = rules.some((rule) => rule.declarations.get("position") === "fixed");
		for (const { selector, declarations, index } of rules) {
			const inset = declarations.get("inset");
			const pinned =
				(inset !== undefined && ZERO.test(inset)) ||
				["top", "right", "bottom", "left"].every((edge) => ZERO.test(declarations.get(edge) ?? ""));
			const position = declarations.get("position");
			if (pinned && (position === "fixed" || (position === undefined && fileFixes))) {
				hits.push({ line: source.slice(0, index).split("\n").length, what: selector });
			}
		}
	}
	return hits;
}

async function allHits(): Promise<Array<Hit & { file: string; kind: "class" | "css" }>> {
	const files = await Array.fromAsync(new Bun.Glob("**/*.svelte").scan(WEB_SRC));
	const out: Array<Hit & { file: string; kind: "class" | "css" }> = [];
	for (const file of files.sort()) {
		const path = relative(WEB_SRC, join(WEB_SRC, file));
		if (path === BACKDROP) continue;
		const source = await Bun.file(join(WEB_SRC, file)).text();
		for (const hit of rawBackdrops(source)) out.push({ ...hit, file: path, kind: "class" });
		for (const hit of rawCssBackdrops(source)) out.push({ ...hit, file: path, kind: "css" });
	}
	return out;
}

const allowedFor = (hit: { file: string; what: string }) =>
	ALLOWED.find((entry) => entry.file === hit.file && entry.selector === hit.what);

describe("rawBackdrops", () => {
	test("finds a fixed box pinned to every edge, in any class order and quoting", () => {
		const source = ['<div class="z-50 fixed bg-black/50 inset-0">', "<div class='fixed inset-0'>", "<div class={`fixed inset-0 \u0024{x}`}>"].join("\n");
		expect(rawBackdrops(source).map((hit) => hit.line)).toEqual([1, 2, 3]);
	});

	test("ignores a box that is not both fixed and inset-0", () => {
		const source = ['<div class="absolute inset-0">', '<div class="fixed top-0 inset-x-0">', '<div class="fixed inset-0-5">'].join("\n");
		expect(rawBackdrops(source)).toEqual([]);
	});
});

describe("rawCssBackdrops", () => {
	test("finds a fixed rule pinned by inset or by all four edges, and a modifier that pins a fixed box", () => {
		const source = [
			"<div></div>",
			"<style>",
			"\t.a { position: fixed; inset: 0; z-index: 80; }",
			"\t.b {",
			"\t\tposition: fixed;",
			"\t\ttop: 0; right: 0px; bottom: 0; left: 0;",
			"\t}",
			"\t.c-mobile { inset: 0; }",
			"</style>",
		].join("\n");
		expect(rawCssBackdrops(source)).toEqual([
			{ line: 3, what: ".a" },
			{ line: 4, what: ".b" },
			{ line: 8, what: ".c-mobile" },
		]);
	});

	test("ignores an absolute overlay, a fixed box with a free edge, and a pinned box in a file with nothing fixed", () => {
		const fixedFile = "<style>.a { position: absolute; inset: 0; } .b { position: fixed; top: 0; right: 0; bottom: 0; } /* inset: 0 */</style>";
		const staticFile = "<style>.c { inset: 0; }</style>";
		expect(rawCssBackdrops(fixedFile)).toEqual([]);
		expect(rawCssBackdrops(staticFile)).toEqual([]);
	});
});

describe("every full-viewport backdrop is ModalBackdrop", () => {
	test("no .svelte file outside ModalBackdrop renders a raw full-viewport fixed box, except reviewed non-backdrops", async () => {
		const raw = (await allHits()).filter((hit) => !allowedFor(hit));
		expect(raw.map((hit) => `${hit.file}:${hit.line} [${hit.kind}] ${hit.what}`)).toEqual([]);
	});

	test("every allowlist entry still matches a box and gives its reason", async () => {
		const hits = await allHits();
		for (const entry of ALLOWED) {
			expect(entry.reason.length).toBeGreaterThan(20);
			expect(hits.some((hit) => hit.file === entry.file && hit.what === entry.selector)).toBe(true);
		}
	});

	test("ModalBackdrop itself is the fixed inset-0 box, with an explicit m-0", async () => {
		const hits = rawBackdrops(await Bun.file(join(WEB_SRC, BACKDROP)).text());
		expect(hits).toHaveLength(1);
		expect(hits[0].what.split(/\s+/)).toContain("m-0");
	});
});
