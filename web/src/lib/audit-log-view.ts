/**
 * Pure view logic for the /settings/admin/audit log page (locked
 * decision 7): consecutive-run grouping and relative timestamps.
 * No Svelte imports — unit-tested under vitest.
 */

export interface AuditViewRow {
	id: string;
	userId: string | null;
	action: string;
	target: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

export interface AuditGroup<T extends AuditViewRow = AuditViewRow> {
	/** Stable key for expand-state — the first row's id. */
	id: string;
	/** Most recent row of the run (API returns newest-first). */
	first: T;
	rows: T[];
	count: number;
}

/**
 * Collapse consecutive rows with identical `action` + actor (`userId`)
 * into one group. Order is preserved; a change in either field — or a
 * null-vs-value actor mismatch — starts a new group.
 */
export function groupConsecutive<T extends AuditViewRow>(rows: T[]): AuditGroup<T>[] {
	const groups: AuditGroup<T>[] = [];
	for (const row of rows) {
		const last = groups[groups.length - 1];
		if (last && last.first.action === row.action && last.first.userId === row.userId) {
			last.rows.push(row);
			last.count += 1;
		} else {
			groups.push({ id: row.id, first: row, rows: [row], count: 1 });
		}
	}
	return groups;
}

/**
 * Render a timestamp relative to `now` with s/m/h/d buckets:
 * "34s ago", "12m ago", "2h ago", "5d ago". Future or invalid
 * timestamps clamp to "0s ago" — corrupt rows must not brick the page.
 * Pass `now` explicitly in tests for determinism.
 */
export function relativeTime(ts: string | number | Date, now: number | Date = Date.now()): string {
	const tsMs = new Date(ts).getTime();
	const nowMs = new Date(now).getTime();
	const diff = Number.isFinite(tsMs) ? Math.max(0, nowMs - tsMs) : 0;

	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Pretty-print metadata for the expanded details panel. */
export function prettyMetadata(metadata: Record<string, unknown> | null): string {
	return metadata ? JSON.stringify(metadata, null, 2) : "-";
}
