/**
 * DOM tests for the `/memories` page wire-in (v1.5 admin tab).
 *
 * Spec: tasks/lessons-keeper-v1.5-admin.md §3.3 — assert the page-level
 * contract that the v1.5 plan owes:
 *   - The "Lessons" tab is present in the tab list.
 *   - Clicking the Lessons tab activates `<LessonsTab>` with the active
 *     `projectId` flowing through as a prop.
 *   - The no-projectId fallback ("Select a project to view lessons.")
 *     renders when no project is active — mirrors the existing Knowledge
 *     Base branch's fallback.
 *
 * The real `LessonsTab.svelte` does its own fetch + state and is covered
 * exhaustively by `LessonsTab.component.test.ts`. Here we substitute a
 * recording stub (`LessonsTabStub.svelte`) so the test can read back the
 * `projectId` prop without spinning up the network surface.
 *
 * Pattern mirrors `agents-new-ez-context.component.test.ts`:
 * `vi.hoisted` shared state, `vi.mock` for `$app/state` + `$lib/stores`,
 * and stubbed-out child components for the sibling tabs that aren't
 * under test.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const { pageState, fakeStore } = vi.hoisted(() => ({
	pageState: {
		url: new URL("http://localhost/memories"),
		route: { id: "/(app)/memories" },
		params: {} as Record<string, string>,
	},
	fakeStore: { activeProjectId: "p1" } as { activeProjectId: string },
}));

vi.mock("$app/state", () => ({ page: pageState }));
vi.mock("$lib/stores.svelte.js", () => ({ store: fakeStore }));

// Replace the heavy sibling tabs with empty renderers — they fetch on
// mount and would pull network state we don't care about for this test.
vi.mock("$lib/components/MemoryList.svelte", async () => {
	const stub = await import("../../../../__tests__/stubs/empty-component.js");
	return { default: stub.default };
});
vi.mock("$lib/components/KnowledgeBaseTab.svelte", async () => {
	const stub = await import("../../../../__tests__/stubs/empty-component.js");
	return { default: stub.default };
});
// `LessonsTab` is the one we ARE testing the wire-in for — substitute a
// recording stub that exposes `projectId` as a `data-project-id` attr.
vi.mock("$lib/components/LessonsTab.svelte", async () => {
	const stub = await import("./LessonsTabStub.svelte");
	return { default: stub.default };
});
// `InfoTooltip` pulls in tooltip-text registry + portal logic; not the
// subject of this test.
vi.mock("$lib/components/InfoTooltip.svelte", async () => {
	const stub = await import("../../../../__tests__/stubs/empty-component.js");
	return { default: stub.default };
});

import MemoriesPage from "../+page.svelte";

beforeEach(() => {
	pageState.url = new URL("http://localhost/memories");
	fakeStore.activeProjectId = "p1";
});

describe("/memories — tab list", () => {
	test('"Lessons" tab is present in the tab list', () => {
		const { getByRole } = render(MemoriesPage);
		// `tabs` array contains `{ id: "lessons", label: "Lessons" }` →
		// rendered as a `<button>Lessons</button>`. We query by role +
		// accessible name (the visible label), which is the user-facing
		// contract the spec pins.
		expect(getByRole("button", { name: "Lessons" })).toBeInTheDocument();
	});
});

describe("/memories — Lessons tab activation", () => {
	test("clicking the Lessons tab mounts <LessonsTab> with the active projectId", async () => {
		const { getByRole, queryByTestId, getByTestId } = render(MemoriesPage);

		// Initially on the "memories" tab → LessonsTab not mounted.
		expect(queryByTestId("lessons-tab-stub")).toBeNull();

		await fireEvent.click(getByRole("button", { name: "Lessons" }));

		await waitFor(() => {
			expect(queryByTestId("lessons-tab-stub")).not.toBeNull();
		});
		expect(getByTestId("lessons-tab-stub").getAttribute("data-project-id")).toBe(
			"p1",
		);
	});
});

describe("/memories — no-projectId fallback (Lessons branch)", () => {
	test('renders "Select a project to view lessons." when activeProjectId is empty', async () => {
		fakeStore.activeProjectId = "";
		const { getByRole, queryByTestId, getByText } = render(MemoriesPage);

		await fireEvent.click(getByRole("button", { name: "Lessons" }));

		// LessonsTab itself must NOT be mounted in the no-project branch
		// — the parent shows a fallback card instead.
		expect(queryByTestId("lessons-tab-stub")).toBeNull();
		expect(getByText("Select a project to view lessons.")).toBeInTheDocument();
	});
});
