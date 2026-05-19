/**
 * Favicon + document.title unread badge.
 *
 * Reuses the existing `unreadStore` (completed-but-unviewed conversations,
 * cleared via markRead when you open the chat) as the count source — so the
 * badge behaves exactly like the per-project rail badges.
 *
 * Two surfaces, by reliability:
 *   1. `document.title` → `(N) ` prefix. Works everywhere, including Safari
 *      (which is unreliable about dynamically-swapped favicons). This is the
 *      robust fallback and is always applied.
 *   2. The favicon itself → the base PNG with a red count bubble painted on a
 *      canvas. Best-effort: if canvas/Image is unavailable or the draw fails
 *      (e.g. tainted canvas), the favicon silently stays the plain icon and
 *      only the title badge shows. Never throws.
 *
 * The DEV indicator (set server-side in hooks.server.ts) prefixes the title
 * with "DEV " and swaps in the dev favicon assets. `decorateTitle` keeps that
 * prefix intact and orders it before the count: `DEV (3) EZCorp | AI Platform`.
 */
import { unreadStore, formatBadgeCount } from "./unread.js";

const MANAGED_LINK_ID = "ez-favicon";
const TITLE_PREFIX = /^(?:DEV )?(?:\(\d+\+?\) )?/;

/**
 * Pure title transform. Idempotent: stripping the managed prefixes before
 * re-adding them means re-running it (e.g. when the MutationObserver re-fires)
 * never accumulates `(3) (3) …`. A no-op when not dev and count is 0.
 */
export function decorateTitle(
	title: string,
	count: number,
	isDev: boolean,
): string {
	const base = title.replace(TITLE_PREFIX, "");
	const dev = isDev ? "DEV " : "";
	const badge = count > 0 ? `(${formatBadgeCount(count)}) ` : "";
	return `${dev}${badge}${base}`;
}

function faviconBase(dev: boolean): string {
	return dev ? "/favicon-dev-192.png" : "/favicon-192.png";
}

/**
 * The single authoritative favicon link.
 *
 * app.html ships multiple `<link rel="icon">` tags (favicon.ico `sizes="any"`
 * + favicon-192.png `sizes="192x192"`). Browsers — Chrome especially — pick
 * the icon by best size match, NOT document order, so merely *appending*
 * another link does not override the visible tab icon. So we take over: keep
 * one managed link and remove every other `rel~="icon"` link, leaving the
 * browser no choice but to render ours. (`rel~="icon"` does not match
 * `apple-touch-icon`, so the iOS home-screen icon is left intact.)
 *
 * Created once with a valid `href` (no icon-less flash), then only its `href`
 * is mutated afterwards — an attribute change our MutationObserver does not
 * watch, so painting can never feed back into a re-decorate loop.
 */
function ensureManagedLink(initialHref: string): HTMLLinkElement | null {
	if (typeof document === "undefined") return null;
	const head = document.head;
	if (!head) return null;

	let link = document.getElementById(
		MANAGED_LINK_ID,
	) as HTMLLinkElement | null;
	if (!link) {
		link = document.createElement("link");
		link.id = MANAGED_LINK_ID;
		link.rel = "icon";
		link.type = "image/png";
		link.href = initialHref;
		head.appendChild(link);
	}

	// Drop the static competitors so the browser must use our link.
	for (const other of head.querySelectorAll<HTMLLinkElement>(
		'link[rel~="icon"]',
	)) {
		if (other.id !== MANAGED_LINK_ID) other.remove();
	}

	return link;
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`favicon load failed: ${src}`));
		img.src = src;
	});
}

function drawBubble(
	ctx: CanvasRenderingContext2D,
	size: number,
	text: string,
): void {
	const wide = text.length >= 3; // "99+"
	const h = size * 0.62;
	const w = wide ? size * 0.92 : h;
	const x = size - w;
	const y = size - h;
	const r = h / 2;

	// Cut a transparent moat so the bubble reads against a busy icon.
	ctx.save();
	ctx.globalCompositeOperation = "destination-out";
	roundRect(ctx, x - 3, y - 3, w + 6, h + 6, r + 3);
	ctx.fill();
	ctx.restore();

	ctx.fillStyle = "#ef4444";
	roundRect(ctx, x, y, w, h, r);
	ctx.fill();

	ctx.fillStyle = "#ffffff";
	ctx.font = `bold ${Math.round(wide ? h * 0.62 : h * 0.74)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, x + w / 2, y + h / 2 + size * 0.02);
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.arcTo(x + w, y, x + w, y + h, rr);
	ctx.arcTo(x + w, y + h, x, y + h, rr);
	ctx.arcTo(x, y + h, x, y, rr);
	ctx.arcTo(x, y, x + w, y, rr);
	ctx.closePath();
}

let paintSeq = 0;

/**
 * Best-effort favicon repaint. Always resolves, never throws. On any
 * unsupported/failed path it leaves (or restores) the plain base favicon so
 * the title badge remains the user-visible signal.
 */
export async function paintFavicon(
	count: number,
	opts: { dev?: boolean } = {},
): Promise<void> {
	const seq = ++paintSeq;
	const base = faviconBase(opts.dev ?? false);
	const link = ensureManagedLink(base);
	if (!link) return;

	if (count <= 0) {
		link.href = base;
		return;
	}

	if (typeof document === "undefined" || typeof Image === "undefined") {
		link.href = base;
		return;
	}

	try {
		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 64;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			link.href = base; // canvas unsupported (e.g. jsdom) → title fallback
			return;
		}
		const img = await loadImage(base);
		if (seq !== paintSeq) return; // a newer paint superseded us
		ctx.drawImage(img, 0, 0, 64, 64);
		drawBubble(ctx, 64, formatBadgeCount(count));
		link.href = canvas.toDataURL("image/png");
	} catch {
		if (seq === paintSeq) link.href = base;
	}
}

/**
 * Wire the badge to `unreadStore` and keep it applied across SvelteKit
 * client navigations (which reset `document.title` from each route's
 * `<svelte:head>`, the same reason the old DEV-prefix observer existed —
 * this supersedes it). Returns a disposer.
 */
export function installFaviconBadge(): () => void {
	if (typeof document === "undefined") return () => {};

	const isDev = document.documentElement.dataset.devIndicator === "1";
	let count = unreadStore.getTotalUnreadCount();

	// Create the managed link (and drop the static competitors) up front so
	// the childList changes happen before the observer is watching.
	ensureManagedLink(faviconBase(isDev));

	let observer: MutationObserver | null = null;

	const redecorate = () => {
		observer?.disconnect();
		const next = decorateTitle(document.title, count, isDev);
		if (next !== document.title) document.title = next;
		void paintFavicon(count, { dev: isDev });
		observer?.observe(document.head, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	};

	observer = new MutationObserver(redecorate);
	const unsub = unreadStore.subscribe(() => {
		count = unreadStore.getTotalUnreadCount();
		redecorate();
	});

	redecorate();

	return () => {
		observer?.disconnect();
		observer = null;
		unsub();
	};
}
