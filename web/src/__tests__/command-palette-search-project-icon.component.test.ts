/**
 * Component tests for the per-conversation project badge in the Cmd+K
 * cross-project message-search results.
 *
 * Each search-result conversation group renders a right-aligned project badge
 * (emoji from the shared store when the project has one, folder glyph
 * otherwise) so users can tell at a glance which project a chat belongs to.
 * The icon is joined from `store.projects` by the hit's `projectId`; this
 * harness mocks that store so a known emoji/fallback pair is exercised.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MessageSearchHit } from "$lib/api.js";

// --- $page store (pathname "/" → no context filtering) ---
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

const { gotoMock, searchMessagesMock } = vi.hoisted(() => ({
	gotoMock: vi.fn(),
	searchMessagesMock: vi.fn(),
}));

vi.mock("$app/navigation", () => ({ goto: gotoMock }));

vi.mock("$lib/api.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, searchMessages: searchMessagesMock };
});

// Store carries an emoji project (projA) and an emoji-less one (projB) so both
// the emoji and folder-fallback render paths are covered. projC is deliberately
// ABSENT to exercise the "project not in store" fallback.
vi.mock("$lib/stores.svelte.js", () => ({
	store: {
		activeProjectId: "projA",
		projects: [
			{ id: "projA", name: "Project A", path: "", icon: "🚀", variables: {}, createdAt: "", updatedAt: "" },
			{ id: "projB", name: "Project B", path: "", icon: null, variables: {}, createdAt: "", updatedAt: "" },
		],
	},
}));

import CommandPalette from "$lib/components/CommandPalette.svelte";

const FOLDER_D = "M3 7v10"; // start of the folder icon path (sidebar parity)

function hit(o: {
	projectId: string;
	projectName: string;
	conversationId: string;
	conversationTitle: string;
	messageId: string;
}): MessageSearchHit {
	return {
		role: "user",
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		snippet: "hello <mark>world</mark>",
		matchType: "both",
		rankLexical: 1,
		rankSemantic: 1,
		score: 1,
		...o,
	} as MessageSearchHit;
}

function setHits(hits: MessageSearchHit[]) {
	searchMessagesMock.mockResolvedValue({
		hits,
		degraded: false,
		requestedMode: "hybrid",
		servedMode: "hybrid",
	});
}

function renderPalette() {
	return render(CommandPalette, {
		props: {
			open: true,
			onclose: () => {},
			activeProjectId: "projA",
			// No active conversation → single flat "Messages" section.
			activeConversationId: null,
		},
	});
}

async function type(container: HTMLElement, value: string) {
	const input = container.querySelector("input[type=text]") as HTMLInputElement;
	await fireEvent.input(input, { target: { value } });
	return input;
}

function badges(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll('[data-testid="palette-project-badge"]')] as HTMLElement[];
}

function badgeFor(container: HTMLElement, projectName: string): HTMLElement {
	const badge = badges(container).find((b) => (b.textContent ?? "").includes(projectName));
	if (!badge) {
		throw new Error(
			`project badge for "${projectName}" not found; have: ${badges(container)
				.map((b) => (b.textContent ?? "").trim())
				.join(" | ")}`,
		);
	}
	return badge;
}

beforeEach(() => {
	gotoMock.mockClear();
	searchMessagesMock.mockClear();
});

describe("CommandPalette — search-result project badge", () => {
	test("a project with an emoji renders that emoji in its conversation badge", async () => {
		setHits([
			hit({
				projectId: "projA",
				projectName: "Project A",
				conversationId: "conv-a",
				conversationTitle: "Alpha Chat",
				messageId: "m-a",
			}),
		]);
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

		const badge = badgeFor(container, "Project A");
		// Emoji rendered in the leading slot; name still present for clarity.
		expect(badge.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe("🚀");
		expect(badge.querySelector("svg")).toBeNull();
		expect(badge.getAttribute("title")).toBe("Project A");
	});

	test("a project without an emoji falls back to the folder glyph", async () => {
		setHits([
			hit({
				projectId: "projB",
				projectName: "Project B",
				conversationId: "conv-b",
				conversationTitle: "Beta Chat",
				messageId: "m-b",
			}),
		]);
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

		const badge = badgeFor(container, "Project B");
		expect(
			[...badge.querySelectorAll("svg path")].some((p) =>
				p.getAttribute("d")?.startsWith(FOLDER_D),
			),
		).toBe(true);
	});

	test("a hit whose project is absent from the store falls back to the folder glyph", async () => {
		setHits([
			hit({
				projectId: "projC", // not in the mocked store
				projectName: "Project C",
				conversationId: "conv-c",
				conversationTitle: "Gamma Chat",
				messageId: "m-c",
			}),
		]);
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() => expect(badges(container).length).toBeGreaterThan(0));

		const badge = badgeFor(container, "Project C");
		expect(
			[...badge.querySelectorAll("svg path")].some((p) =>
				p.getAttribute("d")?.startsWith(FOLDER_D),
			),
		).toBe(true);
	});

	test("each conversation group carries its own project badge", async () => {
		setHits([
			hit({
				projectId: "projA",
				projectName: "Project A",
				conversationId: "conv-a",
				conversationTitle: "Alpha Chat",
				messageId: "m-a",
			}),
			hit({
				projectId: "projB",
				projectName: "Project B",
				conversationId: "conv-b",
				conversationTitle: "Beta Chat",
				messageId: "m-b",
			}),
		]);
		const { container } = renderPalette();
		await type(container, "wor");
		await waitFor(() => expect(searchMessagesMock).toHaveBeenCalled());
		await waitFor(() => expect(badges(container).length).toBe(2));

		expect(badgeFor(container, "Project A").querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe("🚀");
		expect(
			[...badgeFor(container, "Project B").querySelectorAll("svg path")].some((p) =>
				p.getAttribute("d")?.startsWith(FOLDER_D),
			),
		).toBe(true);
	});
});
