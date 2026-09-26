import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, test, vi } from "vitest";

// The page's children each get their own suites; here they are one probe that
// shows the props the page passed, so these tests read the page's own choices.
const { store, setActiveProjectId } = vi.hoisted(() => ({
	store: { projects: [] as { id: string; name: string }[], activeProjectId: "global" },
	setActiveProjectId: vi.fn(),
}));

vi.mock("$lib/stores.svelte.js", () => ({ store, setActiveProjectId }));
vi.mock("$lib/factory/FactoryConsole.svelte", async () => ({ default: (await import("../../../__tests__/stubs/FactoryPropsProbe.svelte")).default }));
vi.mock("$lib/factory/FactoryReleaseInbox.svelte", async () => ({ default: (await import("../../../__tests__/stubs/FactoryPropsProbe.svelte")).default }));
vi.mock("$lib/factory/FactoryRunControls.svelte", async () => ({ default: (await import("../../../__tests__/stubs/FactoryPropsProbe.svelte")).default }));

const { default: FactoriesPage } = await import("./+page.svelte");

function probes(): { projectId: string | undefined; projects: string | undefined }[] {
	return screen.getAllByTestId("factory-props-probe").map(probe => ({ projectId: probe.dataset.projectId, projects: probe.dataset.projects }));
}

const project = (id: string) => ({ id, name: id });

beforeEach(() => {
	setActiveProjectId.mockClear();
	store.projects = [project("global"), project("project-a"), project("project-b")];
	store.activeProjectId = "global";
});

describe("/factories page", () => {
	test("hands the active project to all three panels and hides the global project", () => {
		store.activeProjectId = "project-b";
		render(FactoriesPage);
		expect(probes()).toEqual([
			{ projectId: "project-b", projects: "none" },
			{ projectId: "project-b", projects: "none" },
			{ projectId: "project-b", projects: "project-a,project-b" },
		]);
		expect(document.title).toBe("Factories — EZHarness");
	});

	test("falls back to the first real project when the active one is global or unknown", () => {
		render(FactoriesPage);
		expect(probes().map(entry => entry.projectId)).toEqual(["project-a", "project-a", "project-a"]);
	});

	test("an installation with only the global project gets no project", () => {
		store.projects = [project("global")];
		render(FactoriesPage);
		expect(probes()).toEqual([
			{ projectId: "", projects: "none" },
			{ projectId: "", projects: "none" },
			{ projectId: "", projects: "" },
		]);
	});

	test("a project change in the console sets the active project", async () => {
		render(FactoriesPage);
		await fireEvent.click(screen.getByRole("button", { name: "choose project-b" }));
		expect(setActiveProjectId).toHaveBeenCalledWith("project-b");
		expect(setActiveProjectId).toHaveBeenCalledTimes(1);
	});
});
