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
/** Content-excerpt cap for `detail:"summary"` (the default). */
const MAX_CONTENT_CHARS = 3000;
/** Content-excerpt cap for `detail:"full"` — the LLM asked for more. */
const MAX_CONTENT_CHARS_FULL = 6000;
/** Marks an elided gap between the kept head and tail of a windowed excerpt. */
const CONTENT_SEP = " … ";
/** Rolling tail buffer's overshoot allowance before it prunes its front —
 *  keeps `collectContentText` from re-pruning on every single text node
 *  while still bounding memory to a small multiple of the cap. */
const CONTENT_TAIL_SLACK = 256;

/** Subtrees whose text is chrome or non-content, excluded from the
 *  `content` excerpt. Form controls are excluded so typed values can't
 *  leak through the text channel (values ride the fields' opt-in
 *  `detail:"full"` path, with password masking). */
const CONTENT_SKIP_SELECTOR =
	"script,style,noscript,template,svg,nav,header,footer,aside,input,textarea,select,option";

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
	/** Visible-text excerpt of the page's main content region (`<main>` /
	 *  `[role="main"]` when present, else the whole root) — what the user
	 *  is actually reading. Chrome (nav/header/footer/aside), form-control
	 *  values, and excluded subtrees never contribute. Capped at
	 *  {@link MAX_CONTENT_CHARS} for `detail:"summary"`,
	 *  {@link MAX_CONTENT_CHARS_FULL} for `"full"`: text under the cap comes
	 *  back unchanged, text over it keeps its opening AND its closing
	 *  portion (joined by {@link CONTENT_SEP}) so the newest message on a
	 *  chat page — which sits at the very end of `<main>` — always survives
	 *  a truncation instead of being silently cut off. */
	content: string;
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

/**
 * Window `text` to at most `cap` characters, preferring BOTH ends over just
 * the start. Text that already fits comes back unchanged (no separator —
 * nothing was lost). Text that doesn't keeps its first ⌊cap/3⌋ characters, a
 * {@link CONTENT_SEP} marker, and as much of its tail as still fits within
 * `cap`. The shared primitive behind `collectContentText`'s DOM-walk excerpt
 * and `capSize`'s byte-budget squeeze — both need the same tail-preserving
 * shape, because on a chat page the newest message sits at the very end of
 * `<main>`, and a head-only truncation would silently drop it.
 */
function windowText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const headLen = Math.floor(cap / 3);
	const tailLen = Math.max(cap - headLen - CONTENT_SEP.length, 0);
	return `${text.slice(0, headLen)}${CONTENT_SEP}${text.slice(text.length - tailLen)}`;
}

/**
 * Visible-text excerpt of the page's main content region. Prefers the
 * semantic `<main>` / `[role="main"]` scope when the page declares one
 * (falling back to the whole root), walks its text nodes in document
 * order (never stopping early), and skips chrome/control/excluded
 * subtrees. Whitespace is collapsed.
 *
 * Collection stays memory-bounded without an early break: a head buffer
 * fills up to ⌊cap/3⌋ characters and then freezes, and everything
 * afterwards routes into a rolling tail buffer that only drops text from
 * its own front once it overshoots its budget (plus slack) — so a 50k+
 * char page never balloons the working set, and the buffer at the end of
 * the walk still holds the page's true closing text. The head+tail
 * reconstruction is then windowed through {@link windowText} against
 * {@link MAX_CONTENT_CHARS} (`detail:"summary"`) or
 * {@link MAX_CONTENT_CHARS_FULL} (`"full"`) — a no-op when it already fits.
 */
function collectContentText(root: ParentNode, detail: "summary" | "full"): string {
	const scope: ParentNode =
		(root as Element | Document).querySelector?.('main,[role="main"]') ?? root;
	const doc: Document | null =
		(scope as Element).ownerDocument ?? ((scope as Document).createTreeWalker ? (scope as Document) : null);
	if (!doc?.createTreeWalker) return "";

	const cap = detail === "full" ? MAX_CONTENT_CHARS_FULL : MAX_CONTENT_CHARS;
	const headCap = Math.floor(cap / 3);
	const tailBudget = cap - headCap - CONTENT_SEP.length;

	// NodeFilter.SHOW_TEXT === 0x4 — numeric literal so no global NodeFilter
	// reference is needed (jsdom exposes it on window, not globalThis).
	const walker = doc.createTreeWalker(scope as Node, 0x4);
	const headParts: string[] = [];
	let headLen = 0;
	const tailParts: string[] = [];
	let tailLen = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = (node as Text).parentElement;
		if (!parent || parent.closest(CONTENT_SKIP_SELECTOR) || isExcluded(parent)) continue;
		const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!text) continue;

		if (headLen < headCap) {
			headParts.push(text);
			headLen += text.length + 1;
			continue;
		}
		tailParts.push(text);
		tailLen += text.length + 1;
		while (tailLen > tailBudget + CONTENT_TAIL_SLACK && tailParts.length > 1) {
			tailLen -= (tailParts.shift() as string).length + 1;
		}
	}
	return windowText([...headParts, ...tailParts].join(" "), cap);
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
 * first: links → content halved → field values → content dropped →
 * trailing forms → trailing headings. The content excerpt is squeezed in
 * two steps (halve, then drop) because it's the highest-value field for
 * "what is the user looking at" — structure (forms) survives it only
 * because fill_form is unusable without the form vocabulary. The halving
 * step re-windows through {@link windowText} rather than slicing the head
 * off, so the squeeze keeps the same head+tail shape as the original
 * excerpt instead of regressing to a head-only truncation.
 */
function capSize(ctx: PageContext): PageContext {
	if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;

	// Flag FIRST so every fit-check below measures the exact JSON the
	// caller receives — an early return measured without the flag could
	// land within the flag's own byte cost of the cap and overflow it.
	ctx = { ...ctx, truncated: true };

	if (ctx.links.length > 0) {
		ctx = { ...ctx, links: [] };
		if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;
	}

	if (ctx.content.length > 0) {
		ctx = { ...ctx, content: windowText(ctx.content, Math.floor(MAX_CONTENT_CHARS / 2)) };
		if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;
	}

	ctx = {
		...ctx,
		forms: ctx.forms.map((f) => ({
			id: f.id,
			fields: f.fields.map(({ value: _value, ...rest }) => rest),
		})),
	};
	if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;

	if (ctx.content.length > 0) {
		ctx = { ...ctx, content: "" };
		if (byteLength(JSON.stringify(ctx)) <= MAX_BYTES) return ctx;
	}

	while (byteLength(JSON.stringify(ctx)) > MAX_BYTES && ctx.forms.length > 0) {
		ctx = { ...ctx, forms: ctx.forms.slice(0, -1) };
	}
	while (byteLength(JSON.stringify(ctx)) > MAX_BYTES && ctx.headings.length > 0) {
		ctx = { ...ctx, headings: ctx.headings.slice(0, -1) };
	}
	return ctx;
}

/**
 * Serialize the current page rooted at `root`. `path`/`title` come from the
 * caller (the dispatcher reads them off `window.location` / `document`) so
 * this function stays pure and DOM-only. `detail: "full"` includes field
 * values (never for password/file) and raises the content-excerpt cap from
 * {@link MAX_CONTENT_CHARS} to {@link MAX_CONTENT_CHARS_FULL}; the default
 * `"summary"` omits values and uses the smaller cap.
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
		content: collectContentText(root, detail),
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
