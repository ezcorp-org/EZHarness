/**
 * Ez client-tool dispatcher.
 *
 * The runtime emits an `ez:client-tool` event when the LLM calls a tool
 * flagged `clientSide: true` (`read_page`, `fill_form`, `navigate_to`).
 * The Ez panel forwards each event to `dispatch()`, which acts against the
 * live page and returns a `DispatchResult`. The panel POSTs that result back
 * to `/api/conversations/[id]/tool-results` so the suspended agent loop
 * resolves; the runtime renders `detail` into the LLM-visible tool result.
 *
 *   - `read_page` — serialize the current page (route, title, headings,
 *     forms/fields, links) off the DOM via `page-context.ts`.
 *   - `fill_form` — fill fields on a form discovered by `read_page`; never
 *     submits, refuses password/file inputs.
 *   - `navigate_to` — same-origin allowlist check then SvelteKit `goto`,
 *     with a best-effort serialization of the destination.
 *
 * Why we re-validate `navigate_to` here even though the server tool already
 * does: defense-in-depth. The server check guards against a malicious/buggy
 * LLM; this one guards against a malicious/buggy *server* — if the SSE
 * stream is compromised (or a future extension emits the event directly),
 * the panel still refuses to navigate off-origin.
 */
import {
	serializePageContext,
	fillFormFields,
	type PageContext,
} from "./page-context.js";

const ALLOWED_ROUTE_PREFIXES = [
	"/project/", "/agents/", "/agents", "/new-project", "/marketplace",
	"/extensions/", "/extensions", "/settings", "/active-agents",
	"/memories", "/pipelines", "/runs", "/observability", "/account",
	"/admin/", "/admin", "/docs/", "/docs",
] as const;

export interface EzClientToolEvent {
	conversationId: string;
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export type DispatchResult =
	| { ok: true; toolName: string; toolCallId: string; detail?: Record<string, unknown> }
	| {
			ok: false;
			toolName: string;
			toolCallId: string;
			error: string;
			code: "no-handler" | "invalid-input" | "rejected" | "unknown-tool" | "no-dom";
	  };

export interface DispatcherDeps {
	/** Page-level navigator. Pass SvelteKit's `goto` in production. */
	goto: (path: string) => Promise<unknown> | unknown;
	/** DOM root to serialize/fill within. Defaults to the live `document.body`. */
	root?: ParentNode | null;
	/** Current page path. Defaults to `location.pathname + location.search`. */
	currentPath?: () => string;
	/** Current document title. Defaults to `document.title`. */
	currentTitle?: () => string;
	/** Await the destination route paint before serializing (navigate_to). */
	afterNavigate?: () => Promise<void>;
}

function isInAppPath(path: string): boolean {
	if (!path.startsWith("/")) return false;
	if (path.startsWith("//")) return false;
	if (path.includes("://")) return false;
	if (/[\r\n]/.test(path)) return false;
	// Strip query/hash for prefix matching but keep the original for goto().
	const justPath = path.replace(/[?#].*$/, "");
	return ALLOWED_ROUTE_PREFIXES.some((p) =>
		p.endsWith("/") ? justPath.startsWith(p) : justPath === p || justPath.startsWith(p + "/") || justPath.startsWith(p + "?") || justPath.startsWith(p + "#"),
	);
}

export function isAllowedNavigateTarget(path: unknown): path is string {
	return typeof path === "string" && path.length > 0 && isInAppPath(path);
}

/** Resolve the DOM root, honouring an explicit `null` injection (no DOM). */
function resolveRoot(deps: DispatcherDeps): ParentNode | null {
	if (deps.root !== undefined) return deps.root;
	return typeof document !== "undefined" ? document.body : null;
}

function resolvePath(deps: DispatcherDeps): string {
	if (deps.currentPath) return deps.currentPath();
	return typeof location !== "undefined" ? location.pathname + location.search : "";
}

function resolveTitle(deps: DispatcherDeps): string {
	if (deps.currentTitle) return deps.currentTitle();
	return typeof document !== "undefined" ? document.title : "";
}

function noDom(event: EzClientToolEvent): DispatchResult {
	return {
		ok: false,
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		error: `${event.toolName} needs a browser DOM, but none is available.`,
		code: "no-dom",
	};
}

function handleReadPage(event: EzClientToolEvent, deps: DispatcherDeps): DispatchResult {
	const root = resolveRoot(deps);
	if (!root) return noDom(event);
	const input = event.input as { detail?: unknown } | null | undefined;
	const detail = input?.detail === "full" ? "full" : "summary";
	const page = serializePageContext(root, {
		detail,
		path: resolvePath(deps),
		title: resolveTitle(deps),
	});
	return { ok: true, toolName: event.toolName, toolCallId: event.toolCallId, detail: page as unknown as Record<string, unknown> };
}

function handleFillForm(event: EzClientToolEvent, deps: DispatcherDeps): DispatchResult {
	const root = resolveRoot(deps);
	if (!root) return noDom(event);
	const input = event.input as { formId?: unknown; values?: unknown } | null | undefined;
	const formId = typeof input?.formId === "string" ? input.formId : "";
	const values = input?.values && typeof input.values === "object" ? (input.values as Record<string, unknown>) : null;
	if (!formId || !values) {
		return {
			ok: false,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			error: "fill_form requires a 'formId' (from read_page) and a 'values' object.",
			code: "invalid-input",
		};
	}
	const result = fillFormFields(root, formId, values);
	if (result.notFound) {
		return {
			ok: false,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			error: `No form '${formId}' on the current page. Call read_page first to see the available forms and their ids.`,
			code: "no-handler",
		};
	}
	return {
		ok: true,
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		detail: { formId, filled: result.filled, skipped: result.skipped },
	};
}

async function serializeDestination(deps: DispatcherDeps): Promise<Pick<PageContext, "path" | "title" | "headings"> | undefined> {
	// Best-effort: wait one macrotask for the destination route to paint, then
	// serialize just the identity (path/title/headings) so the model knows
	// where the user landed. Never let a serialization failure fail the nav.
	try {
		await (deps.afterNavigate ?? (() => new Promise<void>((r) => setTimeout(r, 0))))();
		const root = resolveRoot(deps);
		if (!root) return undefined;
		const page = serializePageContext(root, { detail: "summary", path: resolvePath(deps), title: resolveTitle(deps) });
		return { path: page.path, title: page.title, headings: page.headings };
	} catch {
		return undefined;
	}
}

async function handleNavigateTo(event: EzClientToolEvent, deps: DispatcherDeps): Promise<DispatchResult> {
	const input = event.input as { path?: unknown } | null | undefined;
	const path = input?.path;
	if (!isAllowedNavigateTarget(path)) {
		return {
			ok: false,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			error: `navigate_to refused: '${String(path)}' is not a same-origin in-app route.`,
			code: "rejected",
		};
	}
	try {
		await deps.goto(path);
	} catch (err) {
		return {
			ok: false,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			error: `navigate_to failed: ${(err as Error)?.message ?? String(err)}`,
			code: "rejected",
		};
	}
	const destination = await serializeDestination(deps);
	return {
		ok: true,
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		detail: destination ? { path, destination } : { path },
	};
}

export async function dispatch(event: EzClientToolEvent, deps: DispatcherDeps): Promise<DispatchResult> {
	if (event.toolName === "read_page") return handleReadPage(event, deps);
	if (event.toolName === "fill_form") return handleFillForm(event, deps);
	if (event.toolName === "navigate_to") return handleNavigateTo(event, deps);

	return {
		ok: false,
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		error: `Unknown ez client tool '${event.toolName}'`,
		code: "unknown-tool",
	};
}
