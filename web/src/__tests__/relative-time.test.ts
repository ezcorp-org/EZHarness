/**
 * Phase 56 (per-capability TTL UI) — Wave 0 RED scaffold for
 * `formatTtl()` in `web/src/lib/utils/relative-time.ts`.
 *
 * Tests are intentionally failing until Plan 56-03 lands the
 * `Intl.RelativeTimeFormat`-backed `formatTtl()` export. The import
 * at the top of this file does NOT resolve a real symbol today —
 * vitest will surface that as a load-time failure (RED), which is
 * the contract Phase 56 Wave 0 wants pinned on disk.
 *
 * Companion to `relative-time.unit.test.ts` (covers existing
 * `humanizeDuration` + `relativeTime`). DO NOT delete that file or
 * fold its cases here — they pin different rounding contracts.
 *
 * Behavior pinned by these tests (Plan 56-03 will implement):
 *   - `formatTtl(ms, direction)` with three modes:
 *       • "past"     → "30 days ago"          (Intl.RelativeTimeFormat)
 *       • "future"   → "in 7 days"            (Intl.RelativeTimeFormat)
 *       • "absolute" → "2 days"               (parallel to humanizeDuration)
 *   - `null` → literal "Never" (picker null-narrowing for sticky paths).
 *   - sub-minute → "less than a minute ago" sentinel (defensive).
 *   - NaN → same as the sub-minute sentinel (defense per
 *     CONTEXT.md "Claude's Discretion" Intl.RelativeTimeFormat note +
 *     the `humanizeDuration` precedent of collapsing degenerate input).
 *
 * Locale guard: jsdom under Bun may ship a stripped-down ICU that
 * lacks `Intl.RelativeTimeFormat` for "en". The describe block guards
 * with `test.skipIf(!hasEnLocale)` so this suite degrades cleanly on
 * such hosts (RESEARCH Pitfall 5). On the CI (full ICU) the guard
 * is a no-op and every assertion runs.
 */

import { describe, test, expect } from "vitest";
import { formatTtl, humanizeDuration } from "$lib/utils/relative-time";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Locale availability probe. If "en" is missing from
// `supportedLocalesOf`, Intl.RelativeTimeFormat will not produce a
// usable string regardless of the implementation — skip the suite
// in that environment instead of producing false RED noise.
const hasEnLocale =
	typeof Intl !== "undefined" &&
	typeof Intl.RelativeTimeFormat !== "undefined" &&
	Intl.RelativeTimeFormat.supportedLocalesOf(["en"]).includes("en");

describe.skipIf(!hasEnLocale)("formatTtl — Intl.RelativeTimeFormat coverage", () => {
	test("past direction at 30 days produces a non-empty string ending in 'ago'", () => {
		const out = formatTtl(30 * DAY_MS, "past");
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		// `Intl.RelativeTimeFormat` "past" direction in `en` ends with
		// "ago" for every unit (seconds/minutes/hours/days/weeks/months/
		// years). We pin the suffix rather than the unit so the unit
		// choice stays Claude-discretion (days vs weeks vs months at
		// 30d boundary).
		expect(out).toMatch(/ago\s*$/);
	});

	test("future direction at 7 days produces a non-empty string starting with 'in '", () => {
		const out = formatTtl(7 * DAY_MS, "future");
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		// `Intl.RelativeTimeFormat` "future" direction in `en` prefixes
		// with "in " for every unit ("in 7 days", "in 1 hour", etc.).
		expect(out).toMatch(/^in /);
	});

	test("absolute direction at 2 days reuses humanizeDuration verbatim (parallel-formatter contract)", () => {
		// CONTEXT.md Claude's Discretion: planner may use a parallel
		// formatter rather than wholesale replace `humanizeDuration`.
		// The "absolute" mode is the parallel-formatter half — it MUST
		// produce the same string as the existing helper so the
		// "Approve 30 days" button label + sticky-default copy stay
		// stable while the banner/age strings flip to Intl-driven
		// relative output.
		const out = formatTtl(2 * DAY_MS, "absolute");
		expect(out).toBe(humanizeDuration(2 * DAY_MS));
	});

	test("null input returns the literal 'Never' (picker null-narrowing path)", () => {
		// CONTEXT.md locked decision: picker `Never` sets
		// `ttlOverrideMs: null` and `expiresAt: null`. Every surface
		// that formats a TTL needs to handle the null case without a
		// special branch at the call site — `formatTtl(null, ...)`
		// collapses to the spelled-out token.
		expect(formatTtl(null, "past")).toBe("Never");
		// Direction is irrelevant when the value is null.
		expect(formatTtl(null, "future")).toBe("Never");
		expect(formatTtl(null, "absolute")).toBe("Never");
	});

	test("sub-minute (30s) past direction returns 'less than a minute ago' sentinel", () => {
		// Mirror `humanizeDuration`'s `< 1 min` collapse, but spelled
		// out for Intl prose. Keeps the banner readable when a grant
		// expired moments ago (race between sweep tick and banner
		// fetch).
		expect(formatTtl(30_000, "past")).toBe("less than a minute ago");
	});

	test("NaN absolute direction collapses to the sub-minute sentinel (NaN-defensive)", () => {
		// `humanizeDuration(NaN)` returns `< 1 min`; the parallel-mode
		// formatTtl MUST be at least as defensive — a corrupt audit
		// row should not brick the banner. We assert the value
		// equals the `< 1 min` collapse so an implementation that
		// returns "less than a minute ago" (Intl prose) or "< 1 min"
		// (humanizeDuration verbatim) both pass — they share the
		// "absolute < 1 min" semantic.
		const out = formatTtl(Number.NaN, "absolute");
		const sentinel = humanizeDuration(Number.NaN);
		// Accept either the humanizeDuration sentinel verbatim OR the
		// Intl-prose "less than a minute" form, since either is a
		// valid NaN-defensive collapse and CONTEXT.md leaves the
		// exact prose to Claude's Discretion.
		expect([sentinel, "less than a minute"]).toContain(out);
	});
});
