/**
 * jsdom unit tests for the on-demand page-context serializer + form filler.
 *
 * Covers: heading/form/link discovery, stable form ids, label resolution
 * (aria-label / `<label for>` / wrapping label / placeholder), field-name
 * fallbacks, ez-panel + data-ez-private exclusion, password masking, the
 * summary-vs-full detail toggle, the size cap's progressive trim, and the
 * fill path (match precedence, password/file refusal, disabled/read-only
 * skips, and the bubbling input/change events).
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
	serializePageContext,
	fillFormFields,
	STANDALONE_FORM_ID,
} from "../page-context";

function setBody(html: string): HTMLElement {
	document.body.innerHTML = html;
	return document.body;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("serializePageContext — headings", () => {
	test("collects h1-h3 in order, skips empty text, honours path/title", () => {
		const ctx = serializePageContext(
			setBody("<h1>Alpha</h1><h2></h2><h3>Gamma</h3><h4>ignored</h4>"),
			{ path: "/agents/new", title: "New Agent" },
		);
		expect(ctx.path).toBe("/agents/new");
		expect(ctx.title).toBe("New Agent");
		expect(ctx.headings).toEqual(["Alpha", "Gamma"]);
	});

	test("defaults path/title to empty when omitted", () => {
		const ctx = serializePageContext(setBody("<h1>Only</h1>"));
		expect(ctx.path).toBe("");
		expect(ctx.title).toBe("");
	});

	test("caps heading count at 40 (break path)", () => {
		const html = Array.from({ length: 45 }, (_, i) => `<h1>H${i}</h1>`).join("");
		const ctx = serializePageContext(setBody(html));
		expect(ctx.headings).toHaveLength(40);
	});

	test("excludes headings inside the ez panel and data-ez-private subtrees", () => {
		const ctx = serializePageContext(
			setBody(
				'<h1>Visible</h1>' +
					'<div data-testid="ez-panel"><h2>Ez internal</h2></div>' +
					'<section data-ez-private><h3>Secret</h3></section>',
			),
		);
		expect(ctx.headings).toEqual(["Visible"]);
	});
});

describe("serializePageContext — forms + fields", () => {
	test("real form gets a stable id from id / data-testid / index and de-dupes collisions", () => {
		const ctx = serializePageContext(
			setBody(
				'<form id="dup"><input name="a" /></form>' +
					'<form id="dup"><input name="b" /></form>' +
					'<form data-testid="tid"><input name="c" /></form>' +
					'<form><input name="d" /></form>',
			),
		);
		expect(ctx.forms.map((f) => f.id)).toEqual(["dup", "dup-1", "tid", "form-3"]);
	});

	test("field name falls back id → data-testid; type reflects tag; label from <label for>", () => {
		const ctx = serializePageContext(
			setBody(
				'<form id="f">' +
					'<label for="n">Full name</label><input id="n" type="text" />' +
					'<input data-testid="dt" type="email" />' +
					'<textarea name="bio"></textarea>' +
					'<select name="role"><option>a</option></select>' +
					"</form>",
			),
		);
		const fields = ctx.forms[0]!.fields;
		expect(fields).toEqual([
			{ name: "n", label: "Full name", type: "text" },
			{ name: "dt", label: "", type: "email" },
			{ name: "bio", label: "", type: "textarea" },
			{ name: "role", label: "", type: "select" },
		]);
	});

	test("label resolution: aria-label, wrapping label, placeholder, then empty", () => {
		const ctx = serializePageContext(
			setBody(
				'<form id="f">' +
					'<input name="aria" aria-label="Aria label" />' +
					"<label>Wrapping<input name=\"wrap\" /></label>" +
					'<input name="ph" placeholder="Type here" />' +
					'<input name="bare" />' +
					"</form>",
			),
		);
		expect(ctx.forms[0]!.fields).toEqual([
			{ name: "aria", label: "Aria label", type: "text" },
			{ name: "wrap", label: "Wrapping", type: "text" },
			{ name: "ph", label: "Type here", type: "text" },
			{ name: "bare", label: "", type: "text" },
		]);
	});

	test("skips hidden/submit/button inputs and unreferenceable (no name, no label) controls", () => {
		const ctx = serializePageContext(
			setBody(
				'<form id="f">' +
					'<input type="hidden" name="h" />' +
					'<input type="submit" value="Go" />' +
					"<input />" + // no name, no id, no label → dropped
					'<input name="keep" />' +
					"</form>",
			),
		);
		expect(ctx.forms[0]!.fields).toEqual([{ name: "keep", label: "", type: "text" }]);
	});

	test("groups labeled/named controls outside any <form> into the synthetic standalone form", () => {
		const ctx = serializePageContext(
			setBody('<label for="s">Solo</label><input id="s" /><input name="loose" />'),
		);
		expect(ctx.forms).toHaveLength(1);
		expect(ctx.forms[0]!.id).toBe(STANDALONE_FORM_ID);
		expect(ctx.forms[0]!.fields.map((f) => f.name)).toEqual(["s", "loose"]);
	});

	test("caps fields per form at 40 (break path)", () => {
		const inputs = Array.from({ length: 45 }, (_, i) => `<input name="f${i}" />`).join("");
		const ctx = serializePageContext(setBody(`<form id="big">${inputs}</form>`));
		expect(ctx.forms[0]!.fields).toHaveLength(40);
	});

	test("caps forms at 20 and drops the standalone group once full", () => {
		const forms = Array.from({ length: 21 }, (_, i) => `<form><input name="x${i}" /></form>`).join("");
		const ctx = serializePageContext(setBody(`${forms}<input name="solo" />`));
		expect(ctx.forms).toHaveLength(20);
		expect(ctx.forms.some((f) => f.id === STANDALONE_FORM_ID)).toBe(false);
	});

	test("excludes forms/fields inside ez-panel and data-ez-private", () => {
		const ctx = serializePageContext(
			setBody(
				'<form id="real"><input name="ok" /></form>' +
					'<div data-testid="ez-panel"><form id="ez"><input name="nope" /></form></div>' +
					'<section data-ez-private><input name="secret" /></section>',
			),
		);
		expect(ctx.forms.map((f) => f.id)).toEqual(["real"]);
	});
});

describe("serializePageContext — detail + password masking", () => {
	test("summary omits values; full includes them but never for password/file", () => {
		const html =
			'<form id="f">' +
			'<input name="user" value="alice" />' +
			'<input name="pw" type="password" value="s3cret" />' +
			'<input name="doc" type="file" />' +
			"</form>";
		const summary = serializePageContext(setBody(html));
		expect(summary.forms[0]!.fields.every((f) => f.value === undefined)).toBe(true);

		const full = serializePageContext(setBody(html), { detail: "full" });
		const byName = Object.fromEntries(full.forms[0]!.fields.map((f) => [f.name, f]));
		expect(byName.user!.value).toBe("alice");
		expect(byName.pw!.value).toBeUndefined();
		expect(byName.doc!.value).toBeUndefined();
	});
});

describe("serializePageContext — links", () => {
	test("collects labeled same-target links, de-dupes by href, skips empty/excluded", () => {
		const ctx = serializePageContext(
			setBody(
				'<a href="/a">Alpha</a>' +
					'<a href="/a">Alpha dup</a>' + // same href → dropped
					'<a href="/b"></a>' + // empty text → dropped
					'<a>no href</a>' + // no href → not matched by selector, ignored
					'<div data-ez-private><a href="/p">Private</a></div>',
			),
		);
		expect(ctx.links).toEqual([{ text: "Alpha", href: "/a" }]);
	});

	test("caps links at 25 (break path)", () => {
		const links = Array.from({ length: 26 }, (_, i) => `<a href="/l${i}">L${i}</a>`).join("");
		const ctx = serializePageContext(setBody(links));
		expect(ctx.links).toHaveLength(25);
	});
});

describe("serializePageContext — size cap", () => {
	const CAP = 8192;
	const byteLen = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;

	test("small pages are not flagged truncated", () => {
		const ctx = serializePageContext(setBody("<h1>Tiny</h1>"));
		expect(ctx.truncated).toBeUndefined();
	});

	test("drops links first when they push past the cap", () => {
		const big = "x".repeat(200);
		// Distinct prefix so truncation to 200 chars keeps hrefs unique (a
		// shared suffix would collapse under the de-dupe).
		const links = Array.from({ length: 26 }, (_, i) => `<a href="/l${i}-${big}">${big}${i}</a>`).join("");
		const ctx = serializePageContext(setBody(`<h1>Head</h1>${links}`));
		expect(ctx.truncated).toBe(true);
		expect(ctx.links).toEqual([]);
		expect(ctx.headings).toEqual(["Head"]);
		expect(byteLen(ctx)).toBeLessThanOrEqual(CAP);
	});

	test("drops field values when they overflow the cap", () => {
		const big = "v".repeat(200);
		const inputs = Array.from({ length: 45 }, (_, i) => `<input name="f${i}" value="${big}" />`).join("");
		const ctx = serializePageContext(setBody(`<form id="f">${inputs}</form>`), { detail: "full" });
		expect(ctx.truncated).toBe(true);
		expect(ctx.forms[0]!.fields.every((f) => f.value === undefined)).toBe(true);
		expect(byteLen(ctx)).toBeLessThanOrEqual(CAP);
	});

	test("drops trailing forms then headings when heading text alone overflows", () => {
		const big = "h".repeat(200);
		const headings = Array.from({ length: 45 }, () => `<h1>${big}</h1>`).join("");
		const ctx = serializePageContext(
			setBody(`${headings}<form id="f"><input name="a" /></form>`),
			{ path: "p".repeat(200), title: "t".repeat(200) },
		);
		expect(ctx.truncated).toBe(true);
		expect(ctx.forms).toEqual([]);
		expect(ctx.headings.length).toBeLessThan(40);
		expect(byteLen(ctx)).toBeLessThanOrEqual(CAP);
	});
});

describe("fillFormFields", () => {
	test("returns notFound for an unknown formId", () => {
		const res = fillFormFields(setBody('<form id="real"><input name="a" /></form>'), "ghost", { a: "x" });
		expect(res).toEqual({ notFound: true, filled: [], skipped: [] });
	});

	test("fills matched fields, firing bubbling input + change events", () => {
		const root = setBody('<form id="f"><input name="email" id="email" /></form>');
		const input = root.querySelector<HTMLInputElement>("#email")!;
		const events: string[] = [];
		input.addEventListener("input", (e) => events.push(`input:${e.bubbles}`));
		input.addEventListener("change", (e) => events.push(`change:${e.bubbles}`));

		const res = fillFormFields(root, "f", { email: "a@b.c" });
		expect(res.notFound).toBe(false);
		expect(res.filled).toEqual(["email"]);
		expect(res.skipped).toEqual([]);
		expect(input.value).toBe("a@b.c");
		expect(events).toEqual(["input:true", "change:true"]);
	});

	test("matches by id, then case-insensitive name, then case-insensitive label", () => {
		const root = setBody(
			'<form id="f">' +
				'<input name="fname" id="realId" />' + // matched by id
				'<input name="City" />' + // matched by lowercased name
				"<label>Country<input /></label>" + // no name → matched by lowercased label
				"</form>",
		);
		const res = fillFormFields(root, "f", { realId: "1", city: "2", country: "3" });
		expect(res.filled.sort()).toEqual(["city", "country", "realId"]);
		expect(root.querySelector<HTMLInputElement>("#realId")!.value).toBe("1");
	});

	test("sets checkbox checked state rather than value", () => {
		const root = setBody('<form id="f"><input type="checkbox" name="agree" /></form>');
		const res = fillFormFields(root, "f", { agree: true });
		expect(res.filled).toEqual(["agree"]);
		expect(root.querySelector<HTMLInputElement>('[name="agree"]')!.checked).toBe(true);

		fillFormFields(root, "f", { agree: false });
		expect(root.querySelector<HTMLInputElement>('[name="agree"]')!.checked).toBe(false);
	});

	test("refuses password and file inputs, skips disabled/read-only/unmatched", () => {
		const root = setBody(
			'<form id="f">' +
				'<input name="pw" type="password" />' +
				'<input name="doc" type="file" />' +
				'<input name="dis" disabled />' +
				'<input name="ro" readonly />' +
				'<input name="ok" />' +
				"</form>",
		);
		const res = fillFormFields(root, "f", {
			pw: "x",
			doc: "y",
			dis: "z",
			ro: "w",
			missing: "?",
			ok: "done",
		});
		expect(res.filled).toEqual(["ok"]);
		expect(res.skipped).toEqual([
			{ field: "pw", reason: "refused: password field" },
			{ field: "doc", reason: "refused: file input" },
			{ field: "dis", reason: "field is disabled" },
			{ field: "ro", reason: "field is read-only" },
			{ field: "missing", reason: "no matching field on the form" },
		]);
		expect(root.querySelector<HTMLInputElement>('[name="ok"]')!.value).toBe("done");
	});

	test("coerces null/undefined values to empty string", () => {
		const root = setBody('<form id="f"><input name="a" value="prefill" /></form>');
		fillFormFields(root, "f", { a: null });
		expect(root.querySelector<HTMLInputElement>('[name="a"]')!.value).toBe("");
	});
});
