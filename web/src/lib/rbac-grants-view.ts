/**
 * The public wire shape for one extension-RBAC grant, plus the mapper that
 * builds it. Split out from `rbac-grants-logic.ts` on purpose: this module is
 * imported by the server route (`/api/rbac/extension-grants`), so it is
 * measured under the per-file **bun** coverage shard — whereas the page's pure
 * client logic is measured under the **node-vitest** leg. Keeping the two in
 * separate files means each source file is instrumented by exactly ONE runner,
 * avoiding the bun-vs-v8 line-attribution drift that double-measurement causes
 * on multi-line expressions.
 *
 * The page may import `PublicGrantView` as a TYPE (erased at build), so no
 * client bundle ever pulls this runtime in.
 */

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
