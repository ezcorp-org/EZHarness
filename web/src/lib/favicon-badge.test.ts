/**
 * Pure-logic unit tests for the title side of the favicon/unread badge.
 * Runs under `bun test` (no DOM) — companion to the jsdom DOM tests in
 * `__tests__/favicon-badge.component.test.ts` and the Playwright spec
 * `e2e/favicon-unread-badge.spec.ts`.
 */
import { test, expect, describe } from "bun:test";
import {
	decorateTitle,
	paintFavicon,
	installFaviconBadge,
} from "./favicon-badge.js";

const BASE = "EZCorp | AI Platform";

describe("decorateTitle", () => {
	test("no dev, zero count → title untouched", () => {
		expect(decorateTitle(BASE, 0, false)).toBe(BASE);
	});

	test("no dev, positive count → (N) prefix", () => {
		expect(decorateTitle(BASE, 3, false)).toBe(`(3) ${BASE}`);
	});

	test("dev, zero count → DEV prefix only", () => {
		expect(decorateTitle(BASE, 0, true)).toBe(`DEV ${BASE}`);
	});

	test("dev + count → DEV before the count", () => {
		expect(decorateTitle(BASE, 3, true)).toBe(`DEV (3) ${BASE}`);
	});

	test("counts above 99 render as 99+", () => {
		expect(decorateTitle(BASE, 150, false)).toBe(`(99+) ${BASE}`);
	});

	test("idempotent — re-running never accumulates prefixes", () => {
		const once = decorateTitle(BASE, 3, true);
		expect(decorateTitle(once, 3, true)).toBe(once);
	});

	test("strips a stale count prefix before applying the new one", () => {
		expect(decorateTitle(`(2) ${BASE}`, 5, false)).toBe(`(5) ${BASE}`);
	});

	test("strips the 99+ prefix too", () => {
		expect(decorateTitle(`(99+) ${BASE}`, 1, false)).toBe(`(1) ${BASE}`);
	});

	test("count → 0 resets back to the bare title", () => {
		expect(decorateTitle(`(3) ${BASE}`, 0, false)).toBe(BASE);
	});

	test("SSR 'DEV ' title stays stable under the observer", () => {
		expect(decorateTitle(`DEV ${BASE}`, 0, true)).toBe(`DEV ${BASE}`);
	});

	test("re-decorates an already DEV+count title in place", () => {
		expect(decorateTitle(`DEV (2) ${BASE}`, 7, true)).toBe(`DEV (7) ${BASE}`);
	});

	test("dropping dev strips the DEV prefix", () => {
		expect(decorateTitle(`DEV (2) ${BASE}`, 2, false)).toBe(`(2) ${BASE}`);
	});

	test("does not mangle a normal title containing no managed prefix", () => {
		expect(decorateTitle("Settings · EZCorp", 0, false)).toBe(
			"Settings · EZCorp",
		);
	});
});

/**
 * `bun test` has no DOM (no `document`/`Image`) — i.e. the SSR environment.
 * These exercise the no-DOM guard branches that the jsdom suite cannot reach.
 */
describe("SSR / no-DOM guards", () => {
	test("installFaviconBadge returns a callable no-op disposer", () => {
		const dispose = installFaviconBadge();
		expect(typeof dispose).toBe("function");
		expect(() => dispose()).not.toThrow();
	});

	test("paintFavicon is a safe no-op without a document", async () => {
		expect(await paintFavicon(3)).toBeUndefined();
		expect(await paintFavicon(0, { dev: true })).toBeUndefined();
	});
});
