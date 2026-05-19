/**
 * DOM tests for the <LucideIcon> wrapper.
 *
 * Locks down the prop-forwarding contract that the toolbar layout
 * depends on:
 *   1. `size` is forwarded ONLY when the caller passes it. lucide-svelte
 *      is in legacy mode (`width={size}` / `height={size}` hard-coded
 *      with default 24); if the wrapper unconditionally forwards
 *      `size={undefined}`, Tailwind h-N/w-N classes can't override the
 *      24×24 attribute paint. Skipping the prop when undefined lets the
 *      caller's static-imported callers fall back to lucide's default.
 *   2. The `class` prop forwards to the resolved component so callers
 *      can apply Tailwind utilities.
 *   3. Unknown / unsafe icon names fall through to the fallback
 *      (HelpCircle) — surfaced here via the `__setIconLoader` test seam
 *      so we can prove the resolver path without standing up real
 *      lucide imports.
 *
 * Mocking strategy mirrors `lucide-resolver.test.ts`: swap the loader
 * via `__setIconLoader` to return a known-shape stub Svelte component
 * (`StubLucideIcon`) that emits a real SVG with `width`/`height`
 * matching whatever `size` it received. Tests then assert against the
 * DOM attributes — the only contract the production code actually
 * cares about.
 */

import { render, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import LucideIcon from "./LucideIcon.svelte";
import {
	__resetIconCache,
	__setIconLoader,
} from "$lib/lucide-resolver.js";
import StubLucideIcon from "../../__tests__/stubs/StubLucideIcon.svelte";

beforeEach(() => {
	__setIconLoader(async (_kebab: string) => {
		// Track which kebab name was requested via the stub's prop so
		// fallback tests can assert "yes, the resolver actually swapped
		// to help-circle" without a separate spy plumbing.
		return {
			default: ((args?: { props?: Record<string, unknown> }) => {
				// Defensive: `args` is unused — the real Svelte runtime
				// passes its own internals here. We only care that
				// the import resolves to a Svelte component.
				void args;
				return null;
			}) as never,
		};
	});
	// Replace immediately with the real stub component — the closure
	// above is the typed shape; the stub IS the renderable component.
	__setIconLoader(async (kebab: string) => ({
		default: Object.assign(StubLucideIcon as unknown as object, {
			__kebab: kebab,
		}) as never,
	}));
});

afterEach(() => {
	cleanup();
	__setIconLoader(null);
	__resetIconCache();
});

describe("LucideIcon — size prop forwarding", () => {
	test("explicit size={14} reaches the resolved component as width=14 / height=14", async () => {
		const { findByTestId } = render(LucideIcon, { name: "Volume2", size: 14 });
		const svg = await findByTestId("stub-lucide-icon");
		expect(svg.getAttribute("width")).toBe("14");
		expect(svg.getAttribute("height")).toBe("14");
		// Sanity: stub records the literal prop value too.
		expect(svg.getAttribute("data-size-prop")).toBe("14");
	});

	test("omitting size leaves the resolved component on its default (lucide's 24)", async () => {
		const { findByTestId } = render(LucideIcon, { name: "Volume2" });
		const svg = await findByTestId("stub-lucide-icon");
		// LucideIcon does NOT forward `size` when undefined — the stub's
		// default branch paints 24×24 to mirror lucide-svelte legacy mode.
		expect(svg.getAttribute("data-size-prop")).toBe("undefined");
		expect(svg.getAttribute("width")).toBe("24");
		expect(svg.getAttribute("height")).toBe("24");
	});

	test("size={28} forwards verbatim (proves it's not hardcoded to 14)", async () => {
		const { findByTestId } = render(LucideIcon, { name: "Sparkles", size: 28 });
		const svg = await findByTestId("stub-lucide-icon");
		expect(svg.getAttribute("width")).toBe("28");
		expect(svg.getAttribute("height")).toBe("28");
	});
});

describe("LucideIcon — class prop forwarding", () => {
	test("class prop reaches the resolved component", async () => {
		const { findByTestId } = render(LucideIcon, {
			name: "Volume2",
			class: "x-marker text-red-500",
		});
		const svg = await findByTestId("stub-lucide-icon");
		const cls = svg.getAttribute("class") ?? "";
		expect(cls).toContain("x-marker");
		expect(cls).toContain("text-red-500");
	});
});

describe("LucideIcon — fallback path", () => {
	test("unknown icon name falls through to the HelpCircle fallback", async () => {
		// Re-bind the loader so the unknown name rejects but help-circle
		// resolves with a stub that records its kebab name.
		__setIconLoader(async (kebab: string) => {
			if (kebab === "help-circle") {
				return {
					default: StubLucideIcon as never,
				};
			}
			throw new Error(`unknown icon: ${kebab}`);
		});
		__resetIconCache();
		const { findByTestId } = render(LucideIcon, { name: "UnknownIconXyz" });
		// The resolver eventually loads help-circle and the stub mounts.
		// We can't assert on the kebab name from the DOM (it's only
		// observable on the loader), but the fact that the stub renders
		// at all proves the fallback path executed — the unknown name
		// rejection didn't surface as a thrown error.
		const svg = await findByTestId("stub-lucide-icon");
		expect(svg).toBeInTheDocument();
	});

	test("unsafe icon name (path-traversal-shaped) renders the fallback without crashing", async () => {
		const seen: string[] = [];
		__setIconLoader(async (kebab: string) => {
			seen.push(kebab);
			if (kebab === "help-circle") {
				return { default: StubLucideIcon as never };
			}
			throw new Error("unexpected non-fallback request");
		});
		__resetIconCache();
		const { findByTestId } = render(LucideIcon, { name: "../../../etc/passwd" });
		const svg = await findByTestId("stub-lucide-icon");
		expect(svg).toBeInTheDocument();
		// The unsafe name should never be passed to the loader — only
		// the fallback's kebab form should land there.
		expect(seen).not.toContain("../../../etc/passwd");
		expect(seen.some((k) => k.includes("help-circle"))).toBe(true);
	});
});

describe("LucideIcon — async resolution", () => {
	test("renders nothing until the loader resolves", async () => {
		// Delay the loader so the wrapper has a moment with `Resolved == null`.
		let resolveLoader!: (
			value: { default: unknown },
		) => void;
		__setIconLoader(
			() =>
				new Promise<{ default: unknown }>((resolve) => {
					resolveLoader = resolve as typeof resolveLoader;
				}) as Promise<{ default: never }>,
		);
		__resetIconCache();
		const { container, findByTestId } = render(LucideIcon, {
			name: "Volume2",
			size: 14,
		});
		// Pre-resolution: nothing rendered (the wrapper's `{#if Resolved}`
		// block is gated on the resolved component).
		expect(container.querySelector('[data-testid="stub-lucide-icon"]')).toBeNull();
		resolveLoader({ default: StubLucideIcon as never });
		await waitFor(() => findByTestId("stub-lucide-icon"));
	});
});
