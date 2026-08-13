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
 * Every `<input …>` tag in a Svelte source, with the byte offset it starts at.
 *
 * A regex like `/<input[^>]*>/` is wrong here: Svelte attribute values hold
 * arbitrary expressions (`class={a > b ? "x" : "y"}`) and quoted strings that
 * legitimately contain `>`. This walks the tag instead, tracking quote state
 * and `{}` depth, and ends it at the first `>` that is at depth 0 and outside
 * quotes — so a `>` inside an expression or a string cannot truncate the tag
 * and hide the attributes that follow it.
 */
function inputTags(src: string): { tag: string; index: number }[] {
	const out: { tag: string; index: number }[] = [];
	const re = /<input\b/g;
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
	// Not credentials — a stored secret and an address being typed FOR someone
	// else. Both must be "off" so no saved login is offered.
	"web/src/lib/components/settings/SearchBackendSection.svelte": ["off"],
	"web/src/lib/components/settings/InvitesSection.svelte": ["off"],
	"web/src/routes/(app)/project/[id]/integrations/github-projects/+page.svelte": ["off", "off"],
	"web/src/lib/components/ProviderSettings.svelte": ["off", "off"],
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
