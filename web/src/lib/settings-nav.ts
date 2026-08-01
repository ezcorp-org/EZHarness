/**
 * Settings hub navigation registry + legacy-anchor redirect logic.
 *
 * Pure logic only — NO Svelte imports — so the redirect table and nav
 * derivation are unit-testable under vitest (`settings-nav.unit.test.ts`).
 *
 * The old mega-page (`/settings#<anchor>`) deep links MUST keep working:
 * `resolveLegacyHash` maps every historical anchor to its new sub-route
 * (see tasks/settings-ux-overhaul.md locked decision 2).
 */

export interface SettingsNavItem {
	id: string;
	label: string;
	href: string;
	/** Hidden from nav (and redirected away) for non-admin users. */
	adminOnly: boolean;
	/** Legacy `/settings#<anchor>` fragments that map onto this page. */
	anchors: string[];
	/**
	 * Anchors that redirect to the page WITHOUT a fragment (the target
	 * page is short enough that scrolling is meaningless — e.g. the
	 * developer page is a single section).
	 */
	bareAnchors?: string[];
	/** Render indented under the previous top-level item. */
	child?: boolean;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
	{
		id: "models",
		label: "Models & Providers",
		href: "/settings/models",
		// Every control on this page is instance-wide config whose read AND
		// write endpoints require the admin role (`GET /api/settings`,
		// `PUT /api/settings/:key`). Listing it for members showed them a page
		// rendered entirely from DEFAULTS — "exploration off, ladder
		// unconfigured" regardless of the truth — whose saves then failed.
		adminOnly: true,
		anchors: ["providers", "tier", "order", "custom-models"],
	},
	{
		// Shared-search Phase 2 — admin-only backend config + the
		// defaults-for-extensions policy layer (global:search:*). The id
		// is `websearch` (not `search`) so its `settings-nav-{id}` testid
		// doesn't collide with the nav-search input's `settings-nav-search`.
		id: "websearch",
		label: "Search",
		href: "/settings/search",
		adminOnly: true,
		anchors: ["search-backend", "search-defaults"],
	},
	{
		id: "personalization",
		label: "Personalization",
		href: "/settings/personalization",
		adminOnly: false,
		anchors: ["instructions", "modes", "briefing", "audit-visibility", "advanced"],
	},
	{
		id: "briefing",
		label: "Daily Briefing",
		href: "/settings/briefing",
		adminOnly: false,
		anchors: [],
		child: true,
	},
	{
		id: "developer",
		label: "Developer",
		href: "/settings/developer",
		adminOnly: false,
		anchors: [],
		bareAnchors: ["developer", "api-keys"],
	},
	{
		// Extension RBAC grants (per-project / per-extension user scopes).
		// adminOnly is a nav/UX gate only — the grants API already serves
		// manage-grant holders (server-side row scoping); surfacing the nav
		// entry to managers arrives with a follow-up.
		id: "permissions",
		label: "Permissions",
		href: "/settings/permissions",
		adminOnly: true,
		anchors: [],
	},
	{
		id: "admin",
		label: "Admin",
		href: "/settings/admin",
		adminOnly: true,
		anchors: ["users", "teams", "invites", "security", "health"],
	},
	{
		id: "admin-audit",
		label: "Audit Log",
		href: "/settings/admin/audit",
		adminOnly: true,
		anchors: [],
		bareAnchors: ["audit"],
		child: true,
	},
	// Settings v2 — surface the existing System (/admin/dashboard) and
	// Moderation (/admin/moderation) admin pages in the settings nav.
	// ADDITIVE only (locked decision 2): these link OUT to the canonical
	// routes; the routes and the main-sidebar entries are untouched.
	{
		id: "system",
		label: "System",
		href: "/admin/dashboard",
		adminOnly: true,
		anchors: [],
		child: true,
	},
	{
		id: "moderation",
		label: "Moderation",
		href: "/admin/moderation",
		adminOnly: true,
		anchors: [],
		child: true,
	},
];

/** Nav items visible to a user (admin entries filtered for non-admins). */
export function visibleNavItems(isAdmin: boolean): SettingsNavItem[] {
	return SETTINGS_NAV.filter((item) => !item.adminOnly || isAdmin);
}

/**
 * Landing page for `/settings`, and the redirect target for a disallowed
 * anchor or an admin-only page a non-admin reached directly.
 *
 * DERIVED from the nav rather than hardcoded, because it must be a route the
 * user can actually open: this used to be the constant `/settings/models`,
 * which became a redirect LOOP the moment that page turned admin-only (a
 * member bounced off it straight back onto it). Taking the first visible item
 * means re-flagging or reordering a page can never reintroduce that.
 */
export function settingsDefaultRoute(isAdmin: boolean): string {
	// SETTINGS_NAV is a non-empty literal with member-visible entries, so this
	// fallback is unreachable; it exists so the signature stays total.
	return visibleNavItems(isAdmin)[0]?.href ?? "/settings/personalization";
}

/**
 * Where a NON-ADMIN is sent — the landing page for a member, and the bounce
 * target for the admin-only pages that turn one away.
 *
 * Every existing caller is on a path that has already established the visitor
 * is not an admin (`requireAdmin()` returned null), which is why this stayed a
 * constant rather than becoming a call: those sites want the member answer
 * unconditionally. Callers that do NOT yet know the role — `/settings` and the
 * models page — use {@link settingsDefaultRoute} instead.
 */
export const SETTINGS_DEFAULT_ROUTE = settingsDefaultRoute(false);

/**
 * Map a legacy `/settings#<hash>` fragment to its new route.
 *
 * - `hash` may include the leading `#` (as `location.hash` does) or not.
 * - Admin-only targets resolve to the default route for non-admins —
 *   mirrors the server-side gate so the user never bounces twice.
 * - Unknown / empty hash → default route.
 */
export function resolveLegacyHash(hash: string, isAdmin: boolean): string {
	const fallback = settingsDefaultRoute(isAdmin);
	const anchor = hash.replace(/^#/, "").trim();
	if (!anchor) return fallback;
	for (const item of SETTINGS_NAV) {
		const allowed = !item.adminOnly || isAdmin;
		if (item.anchors.includes(anchor)) {
			return allowed ? `${item.href}#${anchor}` : fallback;
		}
		if (item.bareAnchors?.includes(anchor)) {
			return allowed ? item.href : fallback;
		}
	}
	return fallback;
}

/**
 * Which nav item is active for a pathname. Longest-prefix match so
 * `/settings/admin/audit` highlights "Audit Log" rather than "Admin".
 */
export function activeNavId(pathname: string): string | null {
	let best: SettingsNavItem | null = null;
	for (const item of SETTINGS_NAV) {
		if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
			if (!best || item.href.length > best.href.length) best = item;
		}
	}
	return best?.id ?? null;
}
