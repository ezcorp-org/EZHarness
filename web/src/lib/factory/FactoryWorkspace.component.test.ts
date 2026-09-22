import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import FactoryWorkspace, { factoryWorkspaceView } from "./FactoryWorkspace.svelte";

const page = (kind: string, extra: Record<string, unknown> = {}) => Response.json({ schemaVersion: "factory.api.response.v1", kind, page: { items: [] }, ...extra });

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	vi.stubGlobal("fetch", vi.fn(async (input: string) => {
		if (input.includes("/definitions")) return page("draft.page");
		if (input.includes("/notifications")) return page("release.notification.page");
		if (input.includes("/runs")) return page("run.page");
		if (input.includes("/packages")) return page("package.page");
		if (input.includes("/grants")) return page("grant.page");
		return Response.json({ schemaVersion: "factory.api.response.v1", kind: "purge.preview", resource: { tenantId: "tenant-1", ready: true, preconditions: [], auditRowsLost: 0 } });
	}));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderWorkspace(view: Parameters<typeof factoryWorkspaceView>[0] = null) {
	const onViewChange = vi.fn();
	const onProjectChange = vi.fn();
	const result = render(FactoryWorkspace, {
		projects: [{ id: "project-a", name: "Research" }, { id: "project-b", name: "Release" }],
		projectId: "project-a", onProjectChange, view: factoryWorkspaceView(view), onViewChange, tenantId: "tenant-1", administrator: true,
	});
	return { ...result, onViewChange, onProjectChange };
}

describe("factoryWorkspaceView", () => {
	test("trusts only a known view name", () => {
		expect(factoryWorkspaceView("runs")).toBe("runs");
		expect(factoryWorkspaceView("inbox")).toBe("inbox");
		expect(factoryWorkspaceView("admin")).toBe("admin");
		expect(factoryWorkspaceView("authoring")).toBe("authoring");
		expect(factoryWorkspaceView(null)).toBe("authoring");
		expect(factoryWorkspaceView("../settings")).toBe("authoring");
	});
});

describe("FactoryWorkspace", () => {
	test("owns the project choice and shows exactly one selected tab with its panel", async () => {
		const { onProjectChange } = renderWorkspace("runs");
		await fireEvent.change(screen.getByLabelText("Factory project"), { target: { value: "project-b" } });
		expect(onProjectChange).toHaveBeenCalledWith("project-b");
		const tabs = screen.getAllByRole("tab");
		expect(tabs.map(tab => tab.textContent?.trim())).toEqual(["Authoring", "Runs", "Inbox", "Administration"]);
		expect(tabs.map(tab => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
		expect(tabs.map(tab => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
		const panel = screen.getByRole("tabpanel");
		expect(panel.id).toBe("factory-panel-runs");
		expect(panel.getAttribute("aria-labelledby")).toBe("factory-tab-runs");
		expect(await screen.findByTestId("factory-run-inspector")).toBeTruthy();
	});

	test("arrow keys wrap, Home and End jump, and other keys do nothing", async () => {
		const { onViewChange } = renderWorkspace("authoring");
		const [authoring, , , administration] = screen.getAllByRole("tab");
		await fireEvent.keyDown(authoring!, { key: "ArrowLeft" });
		await fireEvent.keyDown(authoring!, { key: "ArrowRight" });
		await fireEvent.keyDown(administration!, { key: "ArrowRight" });
		await fireEvent.keyDown(administration!, { key: "ArrowLeft" });
		await fireEvent.keyDown(authoring!, { key: "End" });
		await fireEvent.keyDown(administration!, { key: "Home" });
		await fireEvent.keyDown(authoring!, { key: "Enter" });
		expect(onViewChange.mock.calls.map(call => call[0])).toEqual(["admin", "runs", "authoring", "inbox", "admin", "authoring"]);
		await fireEvent.click(screen.getByRole("tab", { name: "Inbox" }));
		expect(onViewChange).toHaveBeenLastCalledWith("inbox");
	});

	test("each view renders its own surface", async () => {
		for (const [view, testId] of [["authoring", "factory-console"], ["inbox", "factory-release-inbox"], ["admin", "factory-administration"]] as const) {
			const { unmount } = renderWorkspace(view);
			expect(await screen.findByTestId(testId)).toBeTruthy();
			unmount();
		}
	});

});
