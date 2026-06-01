/**
 * Component tests for the Cmd+K "Projects" drill-down.
 *
 * Mirrors the harness in command-palette-ask-ez.component.test.ts but also mocks
 * `$lib/stores.svelte.js` so the palette sees a fixed project list. Covers the
 * two-level navigation stack (Projects → a project → that project's actions),
 * Back/Backspace popping one level, in-submenu filtering (no global search), and
 * the per-project icon (emoji vs folder fallback).
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";

// --- $app/stores: minimal page store (pathname "/" → no context filtering) ---
vi.mock("$app/stores", () => {
	let listeners: ((v: { url: { pathname: string } }) => void)[] = [];
	const value = { url: { pathname: "/" } };
	return {
		page: {
			subscribe(fn: (v: typeof value) => void) {
				listeners.push(fn);
				fn(value);
				return () => {
					listeners = listeners.filter((l) => l !== fn);
				};
			},
		},
	};
});

// --- $app/navigation: spy on goto (deep-link assertion) ---
const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto: gotoMock }));

// --- $lib/api.js: stub searchMessages (must NOT be called inside a submenu) ---
const { searchMessagesMock } = vi.hoisted(() => ({ searchMessagesMock: vi.fn() }));
vi.mock("$lib/api.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, searchMessages: searchMessagesMock };
});

// --- $lib/stores.svelte.js: fixed project list (one with an emoji, one without) ---
vi.mock("$lib/stores.svelte.js", () => ({
	store: {
		activeProjectId: "global",
		projects: [
			{ id: "a", name: "Alpha", path: "", icon: "🚀", variables: {}, createdAt: "", updatedAt: "" },
			{ id: "b", name: "Beta", path: "", icon: null, variables: {}, createdAt: "", updatedAt: "" },
		],
	},
}));

import CommandPalette from "$lib/components/CommandPalette.svelte";

const FOLDER_D = "M3 7v10"; // start of the folder icon path (sidebar parity)

function renderPalette(props: Record<string, unknown> = {}) {
	return render(CommandPalette, {
		props: {
			open: true,
			onclose: vi.fn(),
			activeProjectId: "global",
			initialView: "commands",
			...props,
		},
	});
}

function rows(container: HTMLElement): HTMLButtonElement[] {
	return [...container.querySelectorAll('[data-row-kind="command"]')] as HTMLButtonElement[];
}

function clickRow(container: HTMLElement, label: string) {
	const btn = rows(container).find((b) => (b.textContent ?? "").includes(label));
	if (!btn) {
		throw new Error(
			`command row "${label}" not found; have: ${rows(container)
				.map((b) => (b.textContent ?? "").trim())
				.join(" | ")}`,
		);
	}
	return fireEvent.click(btn);
}

function input(container: HTMLElement): HTMLInputElement {
	return container.querySelector("input[type=text]") as HTMLInputElement;
}

beforeEach(() => {
	gotoMock.mockClear();
	searchMessagesMock.mockReset();
	searchMessagesMock.mockResolvedValue({ hits: [], degraded: false });
});

describe("CommandPalette — Projects drill-down", () => {
	test("Projects → project → action navigates and closes", async () => {
		const onclose = vi.fn();
		const { container } = renderPalette({ onclose });

		// Level 0: the Projects command is present at the root.
		expect(rows(container).some((b) => (b.textContent ?? "").includes("Projects"))).toBe(true);

		// Level 1: drilling in shows the project list.
		await clickRow(container, "Projects");
		expect(container.textContent).toContain("Alpha");
		expect(container.textContent).toContain("Beta");

		// Level 2: a project shows its scoped actions.
		await clickRow(container, "Alpha");
		expect(container.textContent).toContain("Go to Chat");
		expect(container.textContent).toContain("Go to Settings");
		expect(container.textContent).not.toContain("Go to Overview");

		// Choosing an action deep-links to that project and closes the palette.
		await clickRow(container, "Go to Chat");
		expect(gotoMock).toHaveBeenCalledWith("/project/a/chat");
		expect(onclose).toHaveBeenCalled();
	});

	test("Back pops exactly one level (actions → project list → root)", async () => {
		const { container } = renderPalette();
		await clickRow(container, "Projects");
		await clickRow(container, "Alpha");
		expect(container.textContent).toContain("Go to Chat");

		const back = () => container.querySelector('button[aria-label="Back"]') as HTMLButtonElement;
		await fireEvent.click(back());
		// Back at the project list, not the root.
		expect(container.textContent).toContain("Alpha");
		expect(container.textContent).toContain("Beta");
		expect(container.textContent).not.toContain("Go to Chat");

		await fireEvent.click(back());
		// Back at the root: the Projects command is visible again, no Back button.
		expect(rows(container).some((b) => (b.textContent ?? "").includes("Projects"))).toBe(true);
		expect(container.querySelector('button[aria-label="Back"]')).toBeNull();
	});

	test("Backspace on an empty query pops one level", async () => {
		const { container } = renderPalette();
		await clickRow(container, "Projects");
		await clickRow(container, "Alpha");
		expect(container.textContent).toContain("Go to Chat");

		await fireEvent.keyDown(input(container), { key: "Backspace" });
		expect(container.textContent).toContain("Alpha");
		expect(container.textContent).not.toContain("Go to Chat");
	});

	test("breadcrumb shows the current level title", async () => {
		const { container } = renderPalette();
		await clickRow(container, "Projects");
		expect(container.querySelector('[data-testid="palette-breadcrumb"]')?.textContent?.trim()).toBe(
			"Projects",
		);
		await clickRow(container, "Alpha");
		expect(container.querySelector('[data-testid="palette-breadcrumb"]')?.textContent?.trim()).toBe(
			"Alpha",
		);
	});

	test("typing inside a submenu filters the list and does NOT search messages", async () => {
		const { container } = renderPalette();
		await clickRow(container, "Projects");

		await fireEvent.input(input(container), { target: { value: "alph" } });
		expect(container.textContent).toContain("Alpha");
		expect(container.textContent).not.toContain("Beta");

		// A non-matching filter shows the empty-state, still no network search.
		await fireEvent.input(input(container), { target: { value: "zzz" } });
		expect(container.textContent).toContain("No matching items");

		await new Promise((r) => setTimeout(r, 50)); // let any debounce settle
		expect(searchMessagesMock).not.toHaveBeenCalled();
	});

	test("project rows use the emoji icon when set, folder fallback otherwise", async () => {
		const { container } = renderPalette();

		// The Projects parent uses the folder icon.
		const projectsBtn = rows(container).find((b) => (b.textContent ?? "").includes("Projects"))!;
		expect(
			[...projectsBtn.querySelectorAll("svg path")].some((p) =>
				p.getAttribute("d")?.startsWith(FOLDER_D),
			),
		).toBe(true);

		await clickRow(container, "Projects");
		const alpha = rows(container).find((b) => (b.textContent ?? "").includes("Alpha"))!;
		const beta = rows(container).find((b) => (b.textContent ?? "").includes("Beta"))!;

		// Alpha: emoji rendered in the leading icon slot.
		expect(alpha.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe("🚀");
		// Beta: no emoji → folder fallback svg.
		expect(
			[...beta.querySelectorAll("svg path")].some((p) =>
				p.getAttribute("d")?.startsWith(FOLDER_D),
			),
		).toBe(true);
	});
});
