export interface ExpiredGrant {
	extensionId: string;
	capability: string;
	ageMs: number;
	expiredAt: number; // unix ms
	auditId: string;
	/**
	 * Phase 56 (per-capability TTL UI): the per-row TTL override the
	 * user chose at re-approve time, projected through the sweep onto
	 * this expired row.
	 *   • number  → "Approved for {formatTtl(n, 'absolute')}" copy.
	 *   • null    → "Approved forever" copy (Never sentinel).
	 *   • absent  → legacy row; banner does not render the TTL cell.
	 *
	 * The endpoint surfaces this from the audit row's `ttlMs` metadata
	 * field (the sweep's applied TTL) — see
	 * `src/db/queries/expired-grants.ts` for the wire projection. The
	 * picker's separately-tracked sticky-pick is plumbed via the
	 * `stickyTtlMs` field on the response, NOT here.
	 */
	ttlOverrideMs?: number | null;
	/**
	 * Phase 56 (per-capability TTL UI): the user's previously-chosen
	 * picker TTL for this capability kind. Forwarded through
	 * `onReapprove` so the parent page can seed the modal's
	 * `initialTtlMs` without re-fetching. `null` → first use; the
	 * parent should fall back to `DEFAULT_TTL_FIRST_USE_MS`.
	 */
	stickyTtlMs?: number | null;
}
