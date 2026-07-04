/**
 * Pure logic for the extension-RBAC grants surface (`/settings/permissions`
 * page + the `/api/rbac/extension-grants` routes).
 *
 * NO Svelte imports and NO server imports, so:
 *   - the page's option-derivation / row-shaping is unit-testable under the
 *     node-vitest coverage leg (`rbac-grants-logic.unit.test.ts`), and
 *   - the server routes can share `toPublicGrantView` (the response shape
 *     that guarantees no `passwordHash` — or any other user column — can
 *     ever leak: fields are copied one by one, never spread).
 *
 * The scope-name grammar and the five core verbs MIRROR the backend source
 * of truth in `src/db/queries/extension-rbac.ts` (`CORE_RBAC_SCOPES`,
 * `RBAC_SCOPE_NAME_RE`). They are re-declared here because this module is
 * shipped to the browser — importing the server module would drag drizzle +
 * the DB connection into the client bundle. Keep the two in sync (the
 * backend rejects anything that drifts, so a mismatch fails loudly there).
 */

/** UI option for one grantable scope. `custom: true` = declared by the
 *  selected extension's manifest (`permissions.rbacScopes`), not a core verb. */
export interface ScopeOption {
	name: string;
	description: string;
	custom: boolean;
}

/** The five core verbs every extension supports — names must match
 *  `CORE_RBAC_SCOPES` in `src/db/queries/extension-rbac.ts`; the
 *  descriptions are UI-only. */
export const CORE_RBAC_SCOPE_OPTIONS: readonly ScopeOption[] = [
	{ name: "use", description: "Invoke the extension's tools, pages, and actions; read integration state", custom: false },
	{ name: "configure", description: "Connect/disconnect and edit the extension's configuration", custom: false },
	{ name: "secrets", description: "Set, replace, or delete the extension's stored secrets", custom: false },
	{ name: "approve-runs", description: "Approve, dismiss, or re-run the extension's proposals", custom: false },
	{ name: "manage", description: "Grant/revoke scopes within this project/extension (admins only may grant this)", custom: false },
];

/** Client-side mirror of `RBAC_SCOPE_NAME_RE` (see module header). */
const SCOPE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** True iff `name` is renderable as a manifest-declared CUSTOM scope:
 *  grammar-valid and not colliding with a core verb (mirrors
 *  `isValidCustomRbacScopeName` server-side). */
export function isRenderableCustomScopeName(name: string): boolean {
	return SCOPE_NAME_RE.test(name) && !CORE_RBAC_SCOPE_OPTIONS.some((o) => o.name === name);
}

/** Structurally read `manifest.permissions.rbacScopes` off an unknown
 *  manifest payload. Tolerant by design: the SDK field ships in a parallel
 *  wave, so absent / malformed shapes must degrade to `[]` (core verbs
 *  only), never throw. */
function readDeclaredRbacScopes(manifest: unknown): Array<{ name: string; description: string }> {
	if (typeof manifest !== "object" || manifest === null) return [];
	const permissions = (manifest as Record<string, unknown>).permissions;
	if (typeof permissions !== "object" || permissions === null) return [];
	const raw = (permissions as Record<string, unknown>).rbacScopes;
	if (!Array.isArray(raw)) return [];
	const out: Array<{ name: string; description: string }> = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const name = (entry as Record<string, unknown>).name;
		if (typeof name !== "string") continue;
		const description = (entry as Record<string, unknown>).description;
		out.push({ name, description: typeof description === "string" ? description : "" });
	}
	return out;
}

/**
 * Scope options for the create form: the five core verbs, plus the selected
 * extension's manifest-declared custom scopes when present. Degrades to the
 * core verbs alone for "All extensions" (`null`), an unknown extension, or a
 * manifest without `permissions.rbacScopes`. Invalid names (grammar) and
 * core-verb collisions are dropped; duplicates are de-duplicated.
 */
export function scopeOptionsForExtension(
	extension?: { manifest?: unknown } | null,
): ScopeOption[] {
	const options: ScopeOption[] = [...CORE_RBAC_SCOPE_OPTIONS];
	for (const declared of readDeclaredRbacScopes(extension?.manifest)) {
		if (!isRenderableCustomScopeName(declared.name)) continue;
		if (options.some((o) => o.name === declared.name)) continue;
		options.push({ name: declared.name, description: declared.description, custom: true });
	}
	return options;
}

/** The public wire shape of one grant row — what the API returns and the
 *  page renders. Never contains any credential material. */
export interface PublicGrantView {
	id: string;
	user: { id: string; email: string; name: string };
	projectId: string | null;
	extensionId: string | null;
	scopes: string[];
	grantedBy: string | null;
	updatedAt: string;
}

/**
 * Map a raw `extension_rbac_grants` row + its (optionally resolved) grantee
 * user onto the public view. Fields are copied EXPLICITLY — passing a full
 * `users` row (passwordHash and all) can never leak anything. A missing
 * user (deleted mid-request; FK cascade makes this a razor-thin race)
 * degrades to empty email/name rather than failing the whole list.
 */
export function toPublicGrantView(
	grant: {
		id: string;
		userId: string;
		projectId: string | null;
		extensionId: string | null;
		scopes: string[];
		grantedByUserId: string | null;
		updatedAt: Date | string;
	},
	user?: { id: string; email: string; name: string } | null,
): PublicGrantView {
	return {
		id: grant.id,
		user: {
			id: grant.userId,
			email: user?.email ?? "",
			name: user?.name ?? "",
		},
		projectId: grant.projectId,
		extensionId: grant.extensionId,
		scopes: [...grant.scopes],
		grantedBy: grant.grantedByUserId,
		updatedAt: grant.updatedAt instanceof Date ? grant.updatedAt.toISOString() : String(grant.updatedAt),
	};
}

/** Labels for the NULL (covers-all) coordinates. */
export const ALL_PROJECTS_LABEL = "All projects";
export const ALL_EXTENSIONS_LABEL = "All extensions";

/** One table row, display-ready. */
export interface GrantDisplayRow {
	id: string;
	userLabel: string;
	projectLabel: string;
	extensionLabel: string;
	scopes: string[];
	grantedBy: string | null;
	updatedAt: string;
}

/**
 * Shape a public grant into its display row: user shown by email (name,
 * then id, as fallbacks), project resolved to its name (raw id when the
 * project list doesn't contain it), extension shown by its manifest slug
 * (the slug IS the extension's name — `extensions.name` is the FK target).
 */
export function shapeGrantRow(
	grant: PublicGrantView,
	projects: Array<{ id: string; name: string }>,
): GrantDisplayRow {
	return {
		id: grant.id,
		userLabel: grant.user.email || grant.user.name || grant.user.id,
		projectLabel:
			grant.projectId === null
				? ALL_PROJECTS_LABEL
				: (projects.find((p) => p.id === grant.projectId)?.name ?? grant.projectId),
		extensionLabel: grant.extensionId ?? ALL_EXTENSIONS_LABEL,
		scopes: grant.scopes,
		grantedBy: grant.grantedBy,
		updatedAt: grant.updatedAt,
	};
}

/** Immutable checkbox-toggle for the scope multi-select. */
export function toggleScope(scopes: string[], scope: string): string[] {
	return scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope];
}

/** Client-side pre-flight for the create form. Returns the error message to
 *  surface, or `null` when the draft is submittable. */
export function validateGrantDraft(draft: { userId: string; scopes: string[] }): string | null {
	if (!draft.userId) return "Select a user.";
	if (draft.scopes.length === 0) return "Select at least one scope.";
	return null;
}
