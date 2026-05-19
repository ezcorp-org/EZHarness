import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Tests for the image lightbox store. Following the toast.test.ts convention:
 * Svelte runes can't be imported into bun:test, so we replicate the state-update
 * contract here. The live store at `image-lightbox.svelte.ts` must match this shape.
 */

interface LightboxState {
	open: boolean;
	src: string;
	alt: string;
	originalUrl: string | null;
}

function createLightboxState(): LightboxState {
	return { open: false, src: "", alt: "", originalUrl: null };
}

function show(_prev: LightboxState, src: string, alt: string, originalUrl: string | null = null): LightboxState {
	return { open: true, src, alt, originalUrl };
}

function hide(_prev: LightboxState): LightboxState {
	return { open: false, src: "", alt: "", originalUrl: null };
}

describe("lightbox state contract", () => {
	let state: LightboxState;
	beforeEach(() => {
		state = createLightboxState();
	});

	test("starts closed with empty fields", () => {
		expect(state.open).toBe(false);
		expect(state.src).toBe("");
		expect(state.alt).toBe("");
		expect(state.originalUrl).toBe(null);
	});

	test("show() sets all fields and opens", () => {
		state = show(state, "https://example.com/a.png", "a cat", "https://example.com/a.png");
		expect(state.open).toBe(true);
		expect(state.src).toBe("https://example.com/a.png");
		expect(state.alt).toBe("a cat");
		expect(state.originalUrl).toBe("https://example.com/a.png");
	});

	test("show() defaults originalUrl to null when omitted", () => {
		state = show(state, "data:image/png;base64,AAA", "inline");
		expect(state.originalUrl).toBe(null);
	});

	test("hide() resets all fields", () => {
		state = show(state, "https://example.com/x.png", "x", "https://example.com/x.png");
		state = hide(state);
		expect(state.open).toBe(false);
		expect(state.src).toBe("");
		expect(state.alt).toBe("");
		expect(state.originalUrl).toBe(null);
	});

	test("consecutive show() calls replace state", () => {
		state = show(state, "https://example.com/a.png", "first");
		state = show(state, "https://example.com/b.png", "second", "https://example.com/b.png");
		expect(state.src).toBe("https://example.com/b.png");
		expect(state.alt).toBe("second");
		expect(state.originalUrl).toBe("https://example.com/b.png");
	});

	test("hide() is idempotent when already closed", () => {
		state = hide(state);
		expect(state.open).toBe(false);
		expect(state.src).toBe("");
	});
});
