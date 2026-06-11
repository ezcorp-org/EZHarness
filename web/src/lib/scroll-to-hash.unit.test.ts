/**
 * Unit tests for scrollToLocationHash — the deferred smooth-scroll to
 * `location.hash` on settings sub-page load. jsdom doesn't implement
 * scrollIntoView, so each test installs a spy on Element.prototype.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { scrollToLocationHash } from "./scroll-to-hash";

type ScrollIntoViewFn = (arg?: boolean | ScrollIntoViewOptions) => void;
let scrollSpy: ReturnType<typeof vi.fn<ScrollIntoViewFn>>;

beforeEach(() => {
	vi.useFakeTimers();
	scrollSpy = vi.fn<ScrollIntoViewFn>();
	Element.prototype.scrollIntoView = scrollSpy;
});

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
	window.history.replaceState(null, "", window.location.pathname);
});

describe("scrollToLocationHash", () => {
	test("happy path: scrolls the anchor smoothly after the 100ms default delay", () => {
		const el = document.createElement("div");
		el.id = "audit";
		document.body.appendChild(el);
		window.location.hash = "#audit";

		scrollToLocationHash();
		vi.advanceTimersByTime(99);
		expect(scrollSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(scrollSpy).toHaveBeenCalledTimes(1);
		expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth" });
	});

	test("no hash → no-op (no timer-driven scroll)", () => {
		scrollToLocationHash();
		vi.advanceTimersByTime(1000);
		expect(scrollSpy).not.toHaveBeenCalled();
	});

	test("bare '#' → no-op", () => {
		// Browsers normalize a lone '#' to an empty location.hash, but the
		// guard handles both spellings.
		window.history.replaceState(null, "", "#");
		scrollToLocationHash();
		vi.advanceTimersByTime(1000);
		expect(scrollSpy).not.toHaveBeenCalled();
	});

	test("missing anchor → no scroll, no throw", () => {
		window.location.hash = "#does-not-exist";
		scrollToLocationHash();
		vi.advanceTimersByTime(1000);
		expect(scrollSpy).not.toHaveBeenCalled();
	});

	test("invalid selector in the hash is swallowed by the try/catch", () => {
		// "#123" is an invalid CSS selector — querySelector throws.
		window.location.hash = "#123";
		scrollToLocationHash();
		expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
		expect(scrollSpy).not.toHaveBeenCalled();
	});

	test("custom delay is honored", () => {
		const el = document.createElement("div");
		el.id = "target";
		document.body.appendChild(el);
		window.location.hash = "#target";

		scrollToLocationHash(500);
		vi.advanceTimersByTime(499);
		expect(scrollSpy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(scrollSpy).toHaveBeenCalledTimes(1);
	});
});
