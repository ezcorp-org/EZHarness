/**
 * Repo-wide guard: every credential-bearing `<input>` carries an `autocomplete`.
 *
 * A `type="password"` / `type="email"` field with no `autocomplete` is the
 * browser's cue to guess. Password managers then autofill a saved credential
 * into whatever looks close enough — a signup form gets the login password, an
 * API-key box gets offered the user's account password, and "save password?"
 * fires on fields that hold no password at all. The fix is one attribute per
 * input, which is exactly the kind of thing that gets added to the six screens
 * someone thought about and missed on the seventh.
 *
 * So this is a DERIVED test, not a per-file one: it sweeps every
 * `web/src/**\/*.svelte` and fails on any sensitive input without a non-empty
 * `autocomplete`, naming `file:line`. A new auth screen, a new settings API-key
 * field, or a `+page.svelte` copy-pasted from an old one all trip it on the way
 * in, including in files this branch never touched.
 *
 * PARSED, NEVER IMPORTED — two independent reasons:
 *   1. `.svelte` needs the Svelte compiler at import, which bun lacks (that is
 *      what the Vitest leg exists for; see web/CLAUDE.md).
 *   2. The coverage trap in the root CLAUDE.md: a `bun:test` that imports a
 *      module the Vitest leg measures gets bun's zero-hit `DA` records for
 *      multi-line function signatures merged into V8's, and the module's
 *      coverage DROPS without a line of it becoming less tested. Reading the
 *      files as text keeps the subject identical and the measurement clean.
 * Same pattern (and same reason) as `src/__tests__/author-draft-allowlist-parity.test.ts`.
 *
 * The parser is exercised against inline fixtures below before it is pointed at
 * the tree, so a sweep that reports "no violations" because the SCANNER broke
 * cannot pass silently.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/** `web/src`, resolved from this file so the test is cwd-independent (the bun
 * leg runs from `web/`, the coverage leg from the repo root). */
const WEB_SRC = join(import.meta.dir, "..");

/** Input types a browser treats as credential-bearing. */
const SENSITIVE_TYPES = new Set(["password", "email"]);

/**
 * Blank out HTML comments (preserving newlines so line numbers stay true) so a
 * commented-out example input is not reported as real markup.
 */
function stripComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Every `<{tagName} …>` opening tag in a Svelte source, with the byte offset it
 * starts at.
 *
 * A regex like `/<input[^>]*>/` is wrong here: Svelte attribute values hold
 * arbitrary expressions (`class={a > b ? "x" : "y"}`, `onkeydown={(e) => …}`)
 * and quoted strings that legitimately contain `>`. This walks the tag instead,
 * tracking quote state and `{}` depth, and ends it at the first `>` that is at
 * depth 0 and outside quotes — so a `>` inside an expression or a string cannot
 * truncate the tag and hide the attributes that follow it.
 *
 * Parameterised by tag name because the secret-bearing fields pinned at the
 * bottom of this file are not all `<input>`: two are `<textarea>` holding
 * `Authorization: Bearer …` header blocks, which have no `type` attribute for
 * the type-driven sweep to key on.
 */
function elementTags(src: string, tagName: string): { tag: string; index: number }[] {
	const out: { tag: string; index: number }[] = [];
	const re = new RegExp(`<${tagName}\\b`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		const start = m.index;
		let i = start + m[0].length;
		let quote = "";
		let depth = 0;
		while (i < src.length) {
			const c = src[i];
			if (quote) {
				if (c === quote) quote = "";
			} else if (c === '"' || c === "'") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) break;
			i++;
		}
		out.push({ tag: src.slice(start, i + 1), index: start });
	}
	return out;
}

/** Every `<input …>` tag — the population the type-driven sweep walks. */
function inputTags(src: string): { tag: string; index: number }[] {
	return elementTags(src, "input");
}

/** The literal value of a quoted attribute (`name="v"` / `name='v'`), or null. */
function staticAttr(tag: string, name: string): string | null {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
	if (!m) return null;
	return m[2] ?? m[3] ?? "";
}

/** The source text inside a `name={…}` expression attribute, or null. */
function exprAttr(tag: string, name: string): string | null {
	const m = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(tag);
	if (!m) return null;
	let i = m.index + m[0].length;
	const start = i;
	let depth = 1;
	let quote = "";
	while (i < tag.length && depth > 0) {
		const c = tag[i];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") depth--;
		i++;
	}
	return tag.slice(start, i - 1);
}

/**
 * The credential types an input can take at runtime, or `[]` if it is never
 * sensitive.
 *
 * A dynamic `type={showKey ? "text" : "password"}` counts. The show/hide toggle
 * on an API-key field is a password input in its default state, and the browser
 * offers to fill it exactly as it would a static one — the ternary is not an
 * exemption, it is the same bug wearing a hat.
 */
function sensitiveTypes(tag: string): string[] {
	const found = new Set<string>();
	const literal = staticAttr(tag, "type");
	if (literal !== null && SENSITIVE_TYPES.has(literal)) found.add(literal);
	const expr = exprAttr(tag, "type");
	if (expr !== null) {
		for (const lit of expr.matchAll(/["'`]([^"'`]*)["'`]/g)) {
			if (SENSITIVE_TYPES.has(lit[1] as string)) found.add(lit[1] as string);
		}
	}
	return [...found].sort();
}

/**
 * The input's declared `autocomplete`, or null when absent or empty. An
 * `autocomplete=""` is treated as absent — it tells the browser nothing, so it
 * must not satisfy the guard.
 */
function autocompleteOf(tag: string): string | null {
	const literal = staticAttr(tag, "autocomplete");
	if (literal !== null) return literal.trim() === "" ? null : literal;
	const expr = exprAttr(tag, "autocomplete");
	if (expr !== null) return expr.trim() === "" ? null : `{${expr}}`;
	return null;
}

/** One credential input found in a Svelte source. */
interface SensitiveInput {
	/** Repo-relative path. */
	file: string;
	/** 1-based line the `<input` tag opens on. */
	line: number;
	/** Credential types this input can take (`password`, `email`). */
	types: string[];
	/** Declared autocomplete, or null when missing/empty. */
	autocomplete: string | null;
}

/** Every credential input in one Svelte source, in document order. */
function scanSvelte(src: string, file: string): SensitiveInput[] {
	const clean = stripComments(src);
	const out: SensitiveInput[] = [];
	for (const { tag, index } of inputTags(clean)) {
		const types = sensitiveTypes(tag);
		if (types.length === 0) continue;
		out.push({
			file,
			line: clean.slice(0, index).split("\n").length,
			types,
			autocomplete: autocompleteOf(tag),
		});
	}
	return out;
}

/** Human-readable `file:line` violation line — what a failure actually shows. */
function describeViolation(v: SensitiveInput): string {
	return `${v.file}:${v.line} — <input type="${v.types.join("|")}"> has no autocomplete`;
}

/**
 * The first `<{tagName}>` whose `attr` equals `value`, with its 1-based line.
 * Returns null when the anchor is absent, so a test can report "the anchor
 * moved" rather than throwing an opaque TypeError.
 *
 * Used by the secret-bearing pins at the bottom: those fields carry no `type`
 * the sweep can key on, so each is addressed by a stable anchor (`data-testid`
 * where one exists, `placeholder` otherwise) instead of a line number that
 * every edit above it would invalidate.
 */
function findTagByAttr(
	src: string,
	tagName: string,
	attr: string,
	value: string,
): { tag: string; line: number } | null {
	const clean = stripComments(src);
	for (const { tag, index } of elementTags(clean, tagName)) {
		if (staticAttr(tag, attr) === value) {
			return { tag, line: clean.slice(0, index).split("\n").length };
		}
	}
	return null;
}

// ── Parser fixtures ────────────────────────────────────────────────────────
// The sweep below can only be trusted if the scanner detects a violation it is
// shown. These pin that against known-bad and known-good markup, so a scanner
// that silently stopped matching cannot report a clean tree.

describe("credential-input scanner", () => {
	test("flags a bare password input", () => {
		const found = scanSvelte(`<input id="pw" type="password" />`, "fixture.svelte");
		expect(found).toEqual([
			{ file: "fixture.svelte", line: 1, types: ["password"], autocomplete: null },
		]);
		expect(describeViolation(found[0] as SensitiveInput)).toBe(
			'fixture.svelte:1 — <input type="password"> has no autocomplete',
		);
	});

	test("flags a bare email input", () => {
		expect(scanSvelte(`<input type="email" />`, "f.svelte")[0]?.autocomplete).toBeNull();
		expect(scanSvelte(`<input type="email" />`, "f.svelte")[0]?.types).toEqual(["email"]);
	});

	test("accepts a password input that declares autocomplete", () => {
		const found = scanSvelte(`<input type="password" autocomplete="new-password" />`, "f.svelte");
		expect(found[0]?.autocomplete).toBe("new-password");
	});

	test("an empty autocomplete does NOT satisfy the guard", () => {
		// `autocomplete=""` tells the browser nothing; treating it as present
		// would let the bug back in behind an attribute that looks like a fix.
		expect(scanSvelte(`<input type="password" autocomplete="" />`, "f.svelte")[0]?.autocomplete)
			.toBeNull();
		expect(scanSvelte(`<input type="password" autocomplete="   " />`, "f.svelte")[0]?.autocomplete)
			.toBeNull();
	});

	test("a dynamic show/hide type is still a password input", () => {
		const tag = `<input type={showKey[p.provider] ? "text" : "password"} bind:value={key} />`;
		const found = scanSvelte(tag, "f.svelte");
		expect(found).toHaveLength(1);
		expect(found[0]?.types).toEqual(["password"]);
		expect(found[0]?.autocomplete).toBeNull();
	});

	test("a dynamic type with autocomplete passes", () => {
		const tag = `<input type={show ? "text" : "password"} autocomplete="off" />`;
		expect(scanSvelte(tag, "f.svelte")[0]?.autocomplete).toBe("off");
	});

	test("an expression autocomplete counts as declared", () => {
		const tag = `<input type="password" autocomplete={isNew ? "new-password" : "current-password"} />`;
		expect(scanSvelte(tag, "f.svelte")[0]?.autocomplete).toBe(
			`{isNew ? "new-password" : "current-password"}`,
		);
	});

	test("non-credential inputs are ignored", () => {
		const src = `<input type="text" /><input type="checkbox" /><input type="search" /><input />`;
		expect(scanSvelte(src, "f.svelte")).toEqual([]);
	});

	test("a `>` inside an expression or a quoted value cannot truncate the tag", () => {
		// The naive /<input[^>]*>/ ends the tag at the `>` in `a > b` and never
		// sees the missing autocomplete that follows — a false PASS.
		const tag = `<input class={a > b ? "x" : "y"} type="password" />`;
		const found = scanSvelte(tag, "f.svelte");
		expect(found).toHaveLength(1);
		expect(found[0]?.autocomplete).toBeNull();

		const quoted = `<input placeholder="a > b" type="password" autocomplete="off" />`;
		expect(scanSvelte(quoted, "f.svelte")[0]?.autocomplete).toBe("off");
	});

	test("commented-out markup is not reported, and line numbers survive it", () => {
		const src = `<!--\n<input type="password" />\n-->\n<input type="password" />`;
		const found = scanSvelte(src, "f.svelte");
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(4);
	});

	test("reports the line the tag opens on for a multi-line input", () => {
		const src = `<div>\n\t<input\n\t\tid="pw"\n\t\ttype="password"\n\t/>\n</div>`;
		expect(scanSvelte(src, "f.svelte")[0]?.line).toBe(2);
	});

	test("an arrow-function handler's `=>` does not truncate the tag", () => {
		// ProviderSettings' OAuth paste box carries
		// `onkeydown={(e) => { if (e.key === "Enter") … }}`. The `>` of `=>` sits
		// inside a brace expression, and so does a nested `{…}` block and a
		// quoted string — if any of those ended the tag, every attribute after
		// the handler would be invisible and this guard would report a field as
		// clean while never having seen its autocomplete.
		const tag = `<input type="text" onkeydown={(e) => { if (e.key === "Enter") go(); }} autocomplete="off" />`;
		const found = elementTags(tag, "input");
		expect(found).toHaveLength(1);
		expect(autocompleteOf(found[0]!.tag)).toBe("off");
	});

	test("walks <textarea> as well as <input>", () => {
		// The MCP header boxes are textareas: no `type` attribute exists for the
		// sweep to key on, so they are reachable only through the generic walker.
		const src = `<textarea data-testid="mcp-edit-headers" placeholder="Headers"></textarea>`;
		expect(elementTags(src, "textarea")).toHaveLength(1);
		expect(elementTags(src, "input")).toHaveLength(0);
		expect(autocompleteOf(elementTags(src, "textarea")[0]!.tag)).toBeNull();
	});

	test("the tag-name match is anchored, so <input> does not match <inputmode-ish>", () => {
		expect(elementTags(`<inputx type="password" />`, "input")).toHaveLength(0);
		expect(elementTags(`<textareax />`, "textarea")).toHaveLength(0);
	});

	test("findTagByAttr locates a tag by data-testid or placeholder, else null", () => {
		const src = [
			`<textarea data-testid="mcp-edit-headers" autocomplete="off"></textarea>`,
			`<input placeholder="Paste the callback URL" autocomplete="off" />`,
		].join("\n");
		expect(findTagByAttr(src, "textarea", "data-testid", "mcp-edit-headers")?.line).toBe(1);
		expect(findTagByAttr(src, "input", "placeholder", "Paste the callback URL")?.line).toBe(2);
		// A moved/renamed anchor reports null rather than throwing.
		expect(findTagByAttr(src, "textarea", "data-testid", "gone")).toBeNull();
		// The anchor must match the WHOLE value, not a prefix — otherwise a pin
		// could silently latch onto a different field.
		expect(findTagByAttr(src, "input", "placeholder", "Paste the")).toBeNull();
	});

	test("findTagByAttr ignores an anchor that only appears in a comment", () => {
		const src = `<!-- <textarea data-testid="mcp-edit-headers"></textarea> -->\n<div />`;
		expect(findTagByAttr(src, "textarea", "data-testid", "mcp-edit-headers")).toBeNull();
	});

	test("finds every input in a multi-input form, in document order", () => {
		const src = [
			`<input type="email" autocomplete="username" />`,
			`<input type="password" />`,
			`<input type="password" autocomplete="new-password" />`,
		].join("\n");
		expect(scanSvelte(src, "f.svelte").map((v) => `${v.line}:${v.autocomplete}`)).toEqual([
			"1:username",
			"2:null",
			"3:new-password",
		]);
	});
});

// ── Repo sweep ─────────────────────────────────────────────────────────────

/** Every `web/src/**\/*.svelte`, repo-relative and sorted. */
function svelteFiles(): string[] {
	return [...new Glob("**/*.svelte").scanSync(WEB_SRC)]
		.map((p) => `web/src/${p.replaceAll("\\", "/")}`)
		.sort();
}

/** Scan the whole tree once; shared by the sweep tests below. */
async function scanTree(): Promise<{ files: string[]; inputs: SensitiveInput[] }> {
	const files = svelteFiles();
	const inputs = (
		await Promise.all(
			files.map(async (file) =>
				scanSvelte(await Bun.file(join(WEB_SRC, file.slice("web/src/".length))).text(), file),
			),
		)
	).flat();
	return { files, inputs };
}

describe("every credential input in web/src declares autocomplete", () => {
	test("the sweep actually reaches the tree", async () => {
		// Non-vacuity guard, same reason `test-web.sh` refuses an empty file set:
		// if the glob or the path math breaks, the sweep below finds nothing and
		// passes having checked nothing. Floors, not exact counts, so adding a
		// screen doesn't force an edit here.
		const { files, inputs } = await scanTree();
		expect(files.length).toBeGreaterThan(200);
		expect(files).toContain("web/src/routes/(auth)/login/+page.svelte");
		expect(inputs.length).toBeGreaterThan(15);
	});

	test("no password or email input is missing autocomplete", async () => {
		const { inputs } = await scanTree();
		const violations = inputs.filter((v) => v.autocomplete === null).map(describeViolation);
		expect(
			violations,
			`Credential input(s) without an autocomplete attribute.\n${violations
				.map((v) => `  - ${v}`)
				.join(
					"\n",
				)}\nAdd autocomplete to each: "username" / "current-password" / "new-password" on a ` +
				`real credential form, or "off" on a field that only looks like one (API keys, ` +
				`invite addresses) so a password manager does not offer to fill it.`,
		).toEqual([]);
	});
});

// ── Contract pin for the credential screens ────────────────────────────────
// The sweep only asks for a NON-EMPTY value, which `autocomplete="off"` on the
// login password would satisfy while breaking every password manager. These pin
// the screens where the specific token is the whole point, in document order.

/** file → the autocomplete value of each credential input, in document order. */
const EXPECTED: Record<string, string[]> = {
	"web/src/routes/(auth)/login/+page.svelte": ["username", "current-password"],
	"web/src/routes/(auth)/setup/+page.svelte": ["username", "new-password", "new-password"],
	"web/src/routes/(auth)/signup/[token]/+page.svelte": ["username", "new-password"],
	"web/src/routes/(auth)/reset-password/[token]/+page.svelte": [
		"username",
		"new-password",
		"new-password",
	],
	// Account: email, then the current-password confirmation guarding an email
	// change, then the change-password trio (current, new, confirm).
	"web/src/routes/(app)/account/+page.svelte": [
		"email",
		"current-password",
		"current-password",
		"new-password",
		"new-password",
	],
	// MACHINE credentials in a password-typed box: an API key, a GitHub PAT, a
	// search-backend key. `autocomplete="off"` is NOT enough here — Chrome and
	// Safari deliberately ignore `off` on password-typed inputs (it was too
	// widely used to defeat password managers), so the browser still offers to
	// save the value as a login. `new-password` is the one value that suppresses
	// BOTH the fill and the save prompt. `SchemaForm.svelte` below is the
	// precedent this follows.
	"web/src/lib/components/settings/SearchBackendSection.svelte": ["new-password"],
	"web/src/routes/(app)/project/[id]/integrations/github-projects/+page.svelte": [
		"new-password",
		"new-password",
	],
	"web/src/lib/components/ProviderSettings.svelte": ["new-password", "new-password"],
	// NOT password-typed: an email address being typed FOR someone else. `off` is
	// both honoured and correct on a non-password input, and there is no saved
	// credential a manager could wrongly offer.
	"web/src/lib/components/settings/InvitesSection.svelte": ["off"],
	// An extension's secret-typed setting: a value the author supplies, never a
	// login — "new-password" keeps managers from filling a saved credential.
	"web/src/lib/components/SchemaForm.svelte": ["new-password"],
};

describe("credential screens use the right autocomplete token", () => {
	for (const [file, expected] of Object.entries(EXPECTED)) {
		test(file, async () => {
			const src = await Bun.file(join(WEB_SRC, file.slice("web/src/".length))).text();
			const found = scanSvelte(src, file);
			expect(
				found.map((v) => v.autocomplete ?? "MISSING"),
				`${file} credential inputs (document order) at line(s) ${found
					.map((v) => v.line)
					.join(", ")}`,
			).toEqual(expected);
		});
	}
});

// ── Secret-bearing fields the type-driven sweep cannot see ─────────────────
// The sweep keys on `type="password"` / `type="email"`, which is the only
// generic signal a field holds a credential. These three hold live secrets —
// two `Authorization: Bearer …` header blocks and an OAuth authorization code —
// but are a `type="text"` input and two `<textarea>`s, so no type signal exists
// and a tree-wide rule would have to flag every free-text box in the app.
//
// They are therefore pinned individually, by a stable ANCHOR rather than a line
// number: `data-testid` where one exists, `placeholder` otherwise. Nothing else
// stops someone deleting these attributes, and on these fields autofill means a
// browser writing a saved credential into a bearer-token box.

interface SecretField {
	/** Repo-relative source file. */
	file: string;
	/** Element to walk (`input` / `textarea`). */
	tagName: string;
	/** Anchor attribute + value that identifies the field. */
	attr: string;
	value: string;
	/** Required autocomplete value. */
	expected: string;
	/** What the field holds — why autofill on it is a problem. */
	holds: string;
}

const SECRET_BEARING_FIELDS: readonly SecretField[] = [
	{
		file: "web/src/lib/components/ProviderSettings.svelte",
		tagName: "input",
		attr: "placeholder",
		value: "Paste the callback URL here if automatic redirect didn't work",
		// `type="text"`, so `off` is honoured (the ignore-`off` rule that forces
		// `new-password` on the BYOK key fields applies only to password inputs).
		expected: "off",
		holds: "a live OAuth authorization code pasted from the address bar",
	},
	{
		file: "web/src/routes/(app)/extensions/+page.svelte",
		tagName: "textarea",
		attr: "placeholder",
		value: "Headers (one per line, e.g. Authorization: Bearer ...)",
		expected: "off",
		holds: "MCP request headers, i.e. an `Authorization: Bearer …` token",
	},
	{
		file: "web/src/routes/(app)/extensions/[id]/+page.svelte",
		tagName: "textarea",
		attr: "data-testid",
		value: "mcp-edit-headers",
		expected: "off",
		holds: "MCP request headers on the edit path, same bearer token",
	},
];

describe("secret-bearing non-password fields opt out of autofill", () => {
	for (const f of SECRET_BEARING_FIELDS) {
		test(`${f.file} — ${f.attr}="${f.value}"`, async () => {
			const src = await Bun.file(join(WEB_SRC, f.file.slice("web/src/".length))).text();
			const hit = findTagByAttr(src, f.tagName, f.attr, f.value);
			expect(
				hit,
				`no <${f.tagName}> with ${f.attr}="${f.value}" in ${f.file} — the anchor moved or ` +
					`the field was removed. Re-point this pin at the field that now holds ${f.holds}; ` +
					`do not delete it.`,
			).not.toBeNull();
			expect(
				hit === null ? "(anchor not found)" : (autocompleteOf(hit.tag) ?? "MISSING"),
				`${f.file}:${hit?.line} <${f.tagName}> holds ${f.holds} — it must declare ` +
					`autocomplete="${f.expected}" so the browser neither fills a saved credential ` +
					`into it nor offers to save its contents as one.`,
			).toBe(f.expected);
		});
	}
});
