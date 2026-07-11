/**
 * On-demand page-context serializer for the Ez concierge.
 *
 * The retired `<EzContext>` mechanism pushed a per-page registry payload
 * on every message. This module replaces it with the promised on-demand
 * redesign: the LLM calls `read_page` (client-side tool) and the panel
 * serializes whatever the user is *currently* looking at straight off the
 * live DOM — no per-page instrumentation, no registration. `fill_form`
 * fills fields on that same discovered form.
 *
 * Both entry points are pure over an injected `root` (a `Document`/`Element`
 * to query within), so they unit-test under jsdom without touching globals.
 * Production passes `document.body`.
 *
 * Safety invariants (enforced here, not by the caller):
 *   - The Ez panel's own subtree (`[data-testid="ez-panel"]`) and anything
 *     marked `[data-ez-private]` are excluded from serialization AND fills.
 *   - `type="password"` values are never emitted (masked), even at full
 *     detail; `password`/`file` inputs are never filled.
 *   - Serialized output is capped (~8KB) so a huge page can't blow the
 *     tool-result budget — links, then field values, then trailing
 *     forms/headings are dropped until it fits, flagging `truncated`.
 */

/** Subtrees excluded from both serialization and fills. */
const EXCLUDE_SELECTOR = '[data-testid="ez-panel"],[data-ez-private]';
/** Synthetic form id for labeled controls that live outside any `<form>`. */
export const STANDALONE_FORM_ID = "page-fields";

const MAX_BYTES = 8192;
const MAX_HEADINGS = 40;
const MAX_FORMS = 20;
const MAX_FIELDS_PER_FORM = 40;
const MAX_LINKS = 25;
const MAX_STR = 200;

export interface PageField {
	name: string;
	label: string;
	type: string;
	/** Present only at `detail: "full"`; never for password/file inputs. */
	value?: string;
}

export interface PageForm {
	id: string;
	fields: PageField[];
}

export interface PageLink {
	text: string;
	href: string;
}

export interface PageContext {
	path: string;
	title: string;
	headings: string[];
	forms: PageForm[];
	links: PageLink[];
	/** Set when the output was trimmed to fit the size cap. */
	truncated?: boolean;
}

export interface SerializeOptions {
	detail?: "summary" | "full";
	path?: string;
	title?: string;
}

export interface FillResult {
	/** True when no form matched `formId` — the LLM should call read_page. */
	notFound: boolean;
	/** Field keys (as supplied) that were set. */
	filled: string[];
	skipped: { field: string; reason: string }[];
}

type FieldEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface DiscoveredField {
	el: FieldEl;
	name: string;
	label: string;
	type: string;
}

interface DiscoveredForm {
	id: string;
	fields: DiscoveredField[];
}

function trunc(s: string, max = MAX_STR): string {
	return s.length > max ? s.slice(0, max) : s;
}

function isExcluded(el: Element): boolean {
	return el.closest(EXCLUDE_SELECTOR) !== null;
}

/** Input types that carry no meaningful user-facing value to read/fill. */
function isSkippableInput(el: Element): boolean {
	if (el.tagName !== "INPUT") return false;
	const t = (el.getAttribute("type") ?? "text").toLowerCase();
	return t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "image";
}

function fieldType(el: FieldEl): string {
	if (el.tagName === "TEXTAREA") return "textarea";
	if (el.tagName === "SELECT") return "select";
	return ((el as HTMLInputElement).getAttribute("type") ?? "text").toLowerCase();
}

function fieldName(el: FieldEl): string {
	return el.getAttribute("name") ?? el.getAttribute("id") ?? el.getAttribute("data-testid") ?? "";
}

function fieldLabel(el: FieldEl, root: ParentNode): string {
	const aria = el.getAttribute("aria-label");
	if (aria) return aria.trim();
	// `<label for=id>` — matched manually (no selector string) so ids with
	// awkward characters can't break the query.
	const id = el.getAttribute("id");
	if (id) {
		for (const lab of Array.from(root.querySelectorAll("label"))) {
			if (lab.getAttribute("for") === id) {
				const t = lab.textContent?.trim();
				if (t) return t;
			}
		}
	}
	const wrapping = el.closest("label");
	if (wrapping) {
		const t = wrapping.textContent?.trim();
		if (t) return t;
	}
	const placeholder = el.getAttribute("placeholder");
	if (placeholder) return placeholder.trim();
	return "";
}

function describeField(el: Element, root: ParentNode): DiscoveredField | null {
	if (isSkippableInput(el) || isExcluded(el)) return null;
	const control = el as FieldEl;
	const name = fieldName(control);
	const label = fieldLabel(control, root);
	// Unreferenceable fields (no name/id/data-testid AND no label) can't be
	// matched by read_page → fill_form, so they're not worth surfacing.
	if (!name && !label) return null;
	return { el: control, name, label, type: fieldType(control) };
}

function collectFields(elements: Element[], root: ParentNode): DiscoveredField[] {
	const out: DiscoveredField[] = [];
	for (const el of elements) {
		if (out.length >= MAX_FIELDS_PER_FORM) break;
		const field = describeField(el, root);
		if (field) out.push(field);
	}
	return out;
}

function stableFormId(form: Element, idx: number, used: Set<string>): string {
	const raw = form.getAttribute("id") || form.getAttribute("data-testid") || `form-${idx}`;
	let id = raw;
	let n = 1;
	while (used.has(id)) id = `${raw}-${n++}`;
	used.add(id);
	return id;
}

/**
 * Discover fillable "forms" on the page: real `<form>` elements plus a
 * single synthetic group of labeled controls that live outside any form
 * (the common SvelteKit page shape — inputs bound with `bind:value`, no
 * wrapping `<form>`). Shared by the serializer and the filler so their
 * form-id vocabulary can never drift.
 */
function discoverForms(root: ParentNode): DiscoveredForm[] {
	const out: DiscoveredForm[] = [];
	const used = new Set<string>([STANDALONE_FORM_ID]);

	const forms = Array.from(root.querySelectorAll("form")).filter((f) => !isExcluded(f));
	let idx = 0;
	for (const form of forms) {
		if (out.length >= MAX_FORMS) break;
		const controls = Array.from(form.querySelectorAll("input,select,textarea"));
		out.push({ id: stableFormId(form, idx, used), fields: collectFields(controls, root) });
		idx++;
	}

	const standalone = Array.from(root.querySelectorAll("input,select,textarea")).filter(
		(el) => el.closest("form") === null,
	);
	const standaloneFields = collectFields(standalone, root);
	if (standaloneFields.length > 0 && out.length < MAX_FORMS) {
		out.push({ id: STANDALONE_FORM_ID, fields: standaloneFields });
	}
	return out;
}

function collectHeadings(root: ParentNode): string[] {
	const out: string[] = [];
	for (const h of Array.from(root.querySelectorAll("h1,h2,h3"))) {
		if (out.length >= MAX_HEADINGS) break;
		if (isExcluded(h)) continue;
		const text = trunc((h.textContent ?? "").trim());
		if (text) out.push(text);
	}
	return out;
}

function collectLinks(root: ParentNode): PageLink[] {
	const out: PageLink[] = [];
	const seen = new Set<string>();
	for (const a of Array.from(root.querySelectorAll("a[href]"))) {
		if (out.length >= MAX_LINKS) break;
		if (isExcluded(a)) continue;
		const href = trunc((a.getAttribute("href") ?? "").trim());
		const text = trunc((a.textContent ?? "").trim());
		if (!href || !text || seen.has(href)) continue;
		seen.add(href);
		out.push({ text, href });
	}
	return out;
}

function toPageField(field: DiscoveredField, detail: "summary" | "full"): PageField {
	const out: PageField = { name: field.name, label: trunc(field.label), type: field.type };
	if (detail === "full" && field.type !== "password" && field.type !== "file") {
		out.value = trunc(field.el.value ?? "");
	}
	return out;
}

function byteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}

/**
 * Trim `ctx` until its JSON fits `MAX_BYTES`, dropping the least useful data
 * first: links → field values → trailing forms → trailing headings.
 */
function capSize(ctx: PageContext): PageContext {
	if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;

	if (ctx.links.length > 0) {
		ctx = { ...ctx, links: [] };
		if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return { ...ctx, truncated: true };
	}

	ctx = {
		...ctx,
		forms: ctx.forms.map((f) => ({
			id: f.id,
			fields: f.fields.map(({ value: _value, ...rest }) => rest),
		})),
	};
	if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return { ...ctx, truncated: true };

	while (byteLength(JSON.stringify(ctx)) > MAX_BYTES && ctx.forms.length > 0) {
		ctx = { ...ctx, forms: ctx.forms.slice(0, -1) };
	}
	while (byteLength(JSON.stringify(ctx)) > MAX_BYTES && ctx.headings.length > 0) {
		ctx = { ...ctx, headings: ctx.headings.slice(0, -1) };
	}
	return { ...ctx, truncated: true };
}

/**
 * Serialize the current page rooted at `root`. `path`/`title` come from the
 * caller (the dispatcher reads them off `window.location` / `document`) so
 * this function stays pure and DOM-only. `detail: "full"` includes field
 * values (never for password/file); the default `"summary"` omits them.
 */
export function serializePageContext(root: ParentNode, opts: SerializeOptions = {}): PageContext {
	const detail = opts.detail === "full" ? "full" : "summary";
	const forms = discoverForms(root).map((df) => ({
		id: df.id,
		fields: df.fields.map((f) => toPageField(f, detail)),
	}));
	const ctx: PageContext = {
		path: trunc(opts.path ?? ""),
		title: trunc(opts.title ?? ""),
		headings: collectHeadings(root),
		forms,
		links: collectLinks(root),
	};
	return capSize(ctx);
}

function matchField(fields: DiscoveredField[], key: string): DiscoveredField | null {
	const lower = key.trim().toLowerCase();
	return (
		fields.find((f) => f.name === key) ??
		fields.find((f) => f.el.id === key) ??
		fields.find((f) => f.name.toLowerCase() === lower) ??
		fields.find((f) => f.label.trim().toLowerCase() === lower) ??
		null
	);
}

function fireInputChange(el: FieldEl): void {
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyValue(el: FieldEl, raw: unknown): void {
	const value = raw == null ? "" : String(raw);
	if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox") {
		(el as HTMLInputElement).checked = raw === true || value === "true" || value === "1" || value === "on";
	} else {
		el.value = value;
	}
	// Bubbling input + change so Svelte's `bind:value` / on:change handlers
	// react exactly as if the user typed. We never submit — the user reviews.
	fireInputChange(el);
}

/**
 * Fill fields on the form identified by `formId` (from a prior read_page)
 * with `values` (field key → value). Refuses password/file inputs and skips
 * disabled/read-only/unmatched fields, returning a per-field report. Never
 * submits the form.
 */
export function fillFormFields(root: ParentNode, formId: string, values: Record<string, unknown>): FillResult {
	const form = discoverForms(root).find((f) => f.id === formId);
	if (!form) return { notFound: true, filled: [], skipped: [] };

	const filled: string[] = [];
	const skipped: { field: string; reason: string }[] = [];
	for (const [key, raw] of Object.entries(values)) {
		const field = matchField(form.fields, key);
		if (!field) {
			skipped.push({ field: key, reason: "no matching field on the form" });
			continue;
		}
		if (field.type === "password") {
			skipped.push({ field: key, reason: "refused: password field" });
			continue;
		}
		if (field.type === "file") {
			skipped.push({ field: key, reason: "refused: file input" });
			continue;
		}
		if ((field.el as HTMLInputElement).disabled) {
			skipped.push({ field: key, reason: "field is disabled" });
			continue;
		}
		if ((field.el as HTMLInputElement).readOnly) {
			skipped.push({ field: key, reason: "field is read-only" });
			continue;
		}
		applyValue(field.el, raw);
		filled.push(key);
	}
	return { notFound: false, filled, skipped };
}
