/**
 * Phase 48 Wave 3 — DOM tests for the <EzContext> provider component.
 *
 * Covers:
 *   - register on mount → readSnapshot includes the entry
 *   - unmount deregisters → snapshot is empty
 *   - mounting twice on the same routeId does NOT collapse to a single
 *     entry (each mount owns its symbol-keyed slot)
 *   - aggregate token-overflow triggers a single dev-only console.warn
 *     in `buildEzContextPayload` (so we drive the warning via the
 *     serializer with a snapshot built from the rendered components)
 */
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import EzContext from "$lib/components/ez/EzContext.svelte";
import { readSnapshot, __resetForTests } from "$lib/ez/registry";
import { buildEzContextPayload, TOKEN_BUDGET_CHARS } from "$lib/ez/context-serializer";

// Stub `$app/state` — the component reads `page.route.id` at register time.
vi.mock("$app/state", () => ({
	page: { route: { id: "/(app)/test-route" }, params: {}, url: { pathname: "/test", search: "" } },
}));

beforeEach(() => __resetForTests());

describe("EzContext — register/deregister lifecycle", () => {
	test("registers an entry on mount", () => {
		render(EzContext, { props: { data: { foo: "bar" }, forms: {} } });
		const snap = readSnapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]?.data).toEqual({ foo: "bar" });
		expect(snap[0]?.routeId).toBe("/(app)/test-route");
	});

	test("deregisters when unmounted", () => {
		const { unmount } = render(EzContext, { props: { data: { x: 1 }, forms: {} } });
		expect(readSnapshot()).toHaveLength(1);
		unmount();
		expect(readSnapshot()).toHaveLength(0);
	});

	test("two mounts on the same route do not collapse — each owns a slot", () => {
		const a = render(EzContext, { props: { data: { v: 1 }, forms: {} } });
		const b = render(EzContext, { props: { data: { v: 2 }, forms: {} } });
		expect(readSnapshot()).toHaveLength(2);
		a.unmount();
		expect(readSnapshot()).toHaveLength(1);
		b.unmount();
		expect(readSnapshot()).toHaveLength(0);
	});

	test("explicit routeId prop overrides $page.route.id", () => {
		render(EzContext, { props: { data: {}, forms: {}, routeId: "/custom-route" } });
		expect(readSnapshot()[0]?.routeId).toBe("/custom-route");
	});
});

describe("EzContext — form handlers", () => {
	test("registered forms are findable through the aggregate snapshot", () => {
		const fill = vi.fn();
		render(EzContext, {
			props: {
				data: {},
				forms: {
					"agent-new": { schema: { name: "string" }, fill },
				},
			},
		});
		const snap = readSnapshot();
		expect(snap[0]?.forms["agent-new"]?.fill).toBe(fill);
	});
});

describe("EzContext + serializer — token-budget warning", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		warnSpy.mockRestore();
		if (originalEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalEnv;
	});

	test("dev-warn fires when an EzContext mounts a payload that overflows the cap", () => {
		const big = "x".repeat(TOKEN_BUDGET_CHARS + 100);
		render(EzContext, { props: { data: { huge: big }, forms: {} } });

		// Drive the serializer with the live snapshot — same path the
		// panel takes at send time.
		buildEzContextPayload(
			{ url: { pathname: "/", search: "" }, route: { id: null }, params: {} },
			readSnapshot(),
		);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});
