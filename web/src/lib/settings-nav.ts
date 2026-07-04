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
		adminOnly: false,
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

/** Default landing page for `/settings` and for unknown / disallowed anchors. */
export const SETTINGS_DEFAULT_ROUTE = "/settings/models";

/** Nav items visible to a user (admin entries filtered for non-admins). */
export function visibleNavItems(isAdmin: boolean): SettingsNavItem[] {
	return SETTINGS_NAV.filter((item) => !item.adminOnly || isAdmin);
}

/**
 * Map a legacy `/settings#<hash>` fragment to its new route.
 *
 * - `hash` may include the leading `#` (as `location.hash` does) or not.
 * - Admin-only targets resolve to the default route for non-admins —
 *   mirrors the server-side gate so the user never bounces twice.
 * - Unknown / empty hash → default route.
 */
export function resolveLegacyHash(hash: string, isAdmin: boolean): string {
	const anchor = hash.replace(/^#/, "").trim();
	if (!anchor) return SETTINGS_DEFAULT_ROUTE;
	for (const item of SETTINGS_NAV) {
		const allowed = !item.adminOnly || isAdmin;
		if (item.anchors.includes(anchor)) {
			return allowed ? `${item.href}#${anchor}` : SETTINGS_DEFAULT_ROUTE;
		}
		if (item.bareAnchors?.includes(anchor)) {
			return allowed ? item.href : SETTINGS_DEFAULT_ROUTE;
		}
	}
	return SETTINGS_DEFAULT_ROUTE;
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
