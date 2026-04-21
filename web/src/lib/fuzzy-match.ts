/**
 * Subsequence-based fuzzy scoring.
 *
 * Returns `null` when the query is not a subsequence of the target — i.e.
 * the query chars cannot be found in order (not necessarily contiguously)
 * inside the target. Otherwise returns a number where **higher is better**
 * and is safe to sort against.
 *
 * The scoring is fzf-inspired and intentionally simple:
 *
 *   - **empty query** → 0 (matches everything with neutral score so callers
 *     can keep their own preferred order)
 *   - **exact match** (case-insensitive) → 10_000
 *   - **prefix match** → 5_000 minus the trailing excess length
 *   - **subsequence match** → sum of:
 *       +15 per contiguous run of matches
 *       +10 per match char that follows a word boundary
 *         (`/`, `_`, `-`, `.`, space, or position 0)
 *       −`firstMatchIdx` so earlier starts rank higher
 *       −⌊target.length / 10⌋ as a mild short-path tiebreaker
 *
 * The scoring is comparison-only: the absolute magnitudes are implementation
 * details and should not be relied on outside this module (tests in
 * `fuzzy-match.test.ts` assert the ordering, not the exact numbers).
 */
const BOUNDARY_RE = /[\/_\-.\s]/;

export function fuzzyScore(query: string, target: string): number | null {
	if (query.length === 0) return 0;

	const q = query.toLowerCase();
	const t = target.toLowerCase();

	if (q === t) return 10_000;
	if (t.startsWith(q)) return 5_000 - (target.length - query.length);

	let qi = 0;
	let score = 0;
	let firstMatch = -1;
	let lastMatch = -1;

	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) continue;
		if (firstMatch === -1) firstMatch = ti;
		// Contiguous-run bonus
		if (ti === lastMatch + 1) score += 15;
		// Word-boundary bonus (match at start of target, or immediately after a
		// path-ish separator)
		if (ti === 0 || BOUNDARY_RE.test(t[ti - 1]!)) score += 10;
		lastMatch = ti;
		qi++;
	}

	if (qi < q.length) return null;

	score -= firstMatch;
	score -= Math.floor(target.length / 10);
	return score;
}

/**
 * Convenience wrapper: returns `true` when `target` has any fuzzy match for
 * `query`. Equivalent to `fuzzyScore(query, target) !== null`.
 */
export function fuzzyMatches(query: string, target: string): boolean {
	return fuzzyScore(query, target) !== null;
}
