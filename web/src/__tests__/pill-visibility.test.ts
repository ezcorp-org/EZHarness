/**
 * Phase 52.5 — pure-logic coverage for the pill visibility predicate.
 *
 * Asserts every cell of the truth table:
 *   - non-capability-event role → never shown
 *   - bundled + setting=true / unset → shown
 *   - bundled + setting=false → hidden
 *   - installed + setting=true → shown
 *   - installed + setting=false / unset → hidden
 *   - missing extension → treated as installed (default OFF)
 *   - null / undefined inputs → never crash, return false
 */
import { test, expect, describe } from "bun:test";
import { shouldShowPill, PILL_VISIBILITY_SETTING_KEYS } from "../lib/ez/pill-visibility";

const capRow = { role: "capability-event" };

describe("shouldShowPill", () => {
	test("non-capability-event role → never shown", () => {
		expect(shouldShowPill({ role: "user" }, { isBundled: true }, { [PILL_VISIBILITY_SETTING_KEYS.builtin]: true })).toBe(false);
		expect(shouldShowPill({ role: "assistant" }, { isBundled: false }, { [PILL_VISIBILITY_SETTING_KEYS.installed]: true })).toBe(false);
		expect(shouldShowPill({ role: "ez-action-result" }, { isBundled: true }, {})).toBe(false);
	});

	test("bundled + setting=true → shown", () => {
		expect(shouldShowPill(capRow, { isBundled: true }, { [PILL_VISIBILITY_SETTING_KEYS.builtin]: true })).toBe(true);
	});

	test("bundled + setting unset → shown (default ON)", () => {
		expect(shouldShowPill(capRow, { isBundled: true }, {})).toBe(true);
	});

	test("bundled + setting=false → hidden", () => {
		expect(shouldShowPill(capRow, { isBundled: true }, { [PILL_VISIBILITY_SETTING_KEYS.builtin]: false })).toBe(false);
	});

	test("installed + setting=true → shown", () => {
		expect(shouldShowPill(capRow, { isBundled: false }, { [PILL_VISIBILITY_SETTING_KEYS.installed]: true })).toBe(true);
	});

	test("installed + setting=false → hidden", () => {
		expect(shouldShowPill(capRow, { isBundled: false }, { [PILL_VISIBILITY_SETTING_KEYS.installed]: false })).toBe(false);
	});

	test("installed + setting unset → hidden (default OFF)", () => {
		expect(shouldShowPill(capRow, { isBundled: false }, {})).toBe(false);
	});

	test("missing extension → treated as installed (default OFF)", () => {
		expect(shouldShowPill(capRow, null, {})).toBe(false);
		expect(shouldShowPill(capRow, undefined, { [PILL_VISIBILITY_SETTING_KEYS.installed]: true })).toBe(true);
	});

	test("null/undefined message → false", () => {
		expect(shouldShowPill(null, { isBundled: true }, { [PILL_VISIBILITY_SETTING_KEYS.builtin]: true })).toBe(false);
		expect(shouldShowPill(undefined, { isBundled: true }, { [PILL_VISIBILITY_SETTING_KEYS.builtin]: true })).toBe(false);
	});

	test("null settings → defaults apply", () => {
		expect(shouldShowPill(capRow, { isBundled: true }, null)).toBe(true);
		expect(shouldShowPill(capRow, { isBundled: false }, null)).toBe(false);
	});

	test("undefined settings → defaults apply", () => {
		expect(shouldShowPill(capRow, { isBundled: true }, undefined)).toBe(true);
		expect(shouldShowPill(capRow, { isBundled: false }, undefined)).toBe(false);
	});

	test("non-bundled extension explicitly defaults to installed bucket", () => {
		// `isBundled: undefined` (key absent) is treated as non-bundled.
		expect(shouldShowPill(capRow, {}, { [PILL_VISIBILITY_SETTING_KEYS.installed]: true })).toBe(true);
		expect(shouldShowPill(capRow, {}, {})).toBe(false);
	});

	test("PILL_VISIBILITY_SETTING_KEYS exposes the canonical setting names", () => {
		// Defends against a future refactor that silently renames the keys
		// — the settings page reads these constants via the shared symbol.
		expect(PILL_VISIBILITY_SETTING_KEYS.builtin).toBe("global:showBuiltinCapabilityEvents");
		expect(PILL_VISIBILITY_SETTING_KEYS.installed).toBe("global:showInstalledCapabilityEvents");
	});
});
