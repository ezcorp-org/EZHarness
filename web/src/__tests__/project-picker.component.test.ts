import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("$lib/use-breakpoint.svelte", () => ({ useBreakpoint: () => ({ below: false }) }));
import ProjectPicker from "$lib/components/ProjectPicker.svelte";

afterEach(() => vi.unstubAllGlobals());

function projectsResponse() {
	return new Response(JSON.stringify([
		{ id: "alpha", name: "Alpha", icon: "🚀" },
		{ id: "beta", name: "Beta" },
	]), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ProjectPicker", () => {
	test("selects and removes projects, then returns to the org-wide scope", async () => {
		const onchange = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async () => projectsResponse()));
		const { getByTestId, getByText } = render(ProjectPicker, { selectedIds: ["alpha"], onchange });
		await waitFor(() => expect(getByTestId("open-project-picker")).toHaveTextContent("1 project"));
		await fireEvent.click(getByTestId("open-project-picker"));
		await fireEvent.click(getByTestId("project-picker-item-alpha"));
		expect(onchange).toHaveBeenLastCalledWith([]);
		await fireEvent.click(getByTestId("project-picker-global"));
		expect(onchange).toHaveBeenLastCalledWith([]);
		expect(getByText("Org-wide (Global)")).toBeInTheDocument();
	});

	test("filters projects and closes a single-project picker after choosing one", async () => {
		const onchange = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async () => projectsResponse()));
		const { getByTestId, getByPlaceholderText, queryByTestId } = render(ProjectPicker, { selectedIds: [], onchange, single: true });
		await waitFor(() => expect(getByTestId("open-project-picker")).toHaveTextContent("Select project"));
		await fireEvent.click(getByTestId("open-project-picker"));
		await fireEvent.input(getByPlaceholderText("Search projects..."), { target: { value: "beta" } });
		expect(queryByTestId("project-picker-item-alpha")).toBeNull();
		await fireEvent.click(getByTestId("project-picker-item-beta"));
		expect(onchange).toHaveBeenCalledWith(["beta"]);
		expect(queryByTestId("project-picker-dropdown")).toBeNull();
	});

	test("renders an empty result and closes when the user clicks away", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => projectsResponse()));
		const { getByTestId, getByPlaceholderText, getByText, queryByTestId } = render(ProjectPicker, { selectedIds: [], onchange: vi.fn() });
		await waitFor(() => expect(getByTestId("open-project-picker")).toBeInTheDocument());
		await fireEvent.click(getByTestId("open-project-picker"));
		await fireEvent.input(getByPlaceholderText("Search projects..."), { target: { value: "unknown" } });
		expect(getByText('No projects match "unknown"')).toBeInTheDocument();
		await fireEvent.click(document.body);
		expect(queryByTestId("project-picker-dropdown")).toBeNull();
	});
});
