import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	page: { params: { id: "project-1" } },
	store: { projects: [] as Array<{ id: string; name: string; path: string; icon: null; variables: Record<string, unknown> }> },
	fetchSettings: vi.fn(),
	refreshProjects: vi.fn(),
	setActiveProjectId: vi.fn(),
	goto: vi.fn(),
}));

vi.mock("$app/state", () => ({ page: state.page }));
vi.mock("$app/navigation", () => ({ goto: state.goto }));
vi.mock("$lib/stores.svelte.js", () => ({
	store: state.store,
	refreshProjects: state.refreshProjects,
	setActiveProjectId: state.setActiveProjectId,
}));
vi.mock("$lib/api.js", () => ({
	fetchSettings: state.fetchSettings,
	updateProject: vi.fn(),
	deleteProject: vi.fn(),
	upsertSetting: vi.fn(),
}));
vi.mock("$lib/project-icon.js", () => ({ isIconUrl: () => false }));
vi.mock("$lib/components/ProjectForm.svelte", async () => ({ default: (await import("./ProjectFormStub.svelte")).default }));
vi.mock("$lib/components/FeatureIndex.svelte", async () => ({ default: (await import("./FeatureIndexStub.svelte")).default }));
vi.mock("$lib/components/ProjectSandboxPanel.svelte", async () => ({ default: (await import("./SandboxPanelStub.svelte")).default }));
vi.mock("$lib/components/InfoTooltip.svelte", async () => ({ default: (await import("./EmptyStub.svelte")).default }));
vi.mock("$lib/components/settings/ComposerSuggestSection.svelte", async () => ({ default: (await import("./EmptyStub.svelte")).default }));
vi.mock("$lib/components/settings/SaveIndicator.svelte", async () => ({ default: (await import("./EmptyStub.svelte")).default }));

import SettingsPage from "../+page.svelte";

const ordinary = { id: "project-1", name: "Project", path: "", icon: null, variables: {} };

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
	state.page.params.id = ordinary.id;
	state.store.projects = [{ ...ordinary }];
	state.fetchSettings.mockReset().mockResolvedValue({});
	state.refreshProjects.mockReset();
	state.setActiveProjectId.mockReset();
	state.goto.mockReset();
	vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith(`/api/projects/${ordinary.id}/incus-feature`)) return response({ kind: "none" });
		if (url.endsWith(`/api/projects/${ordinary.id}/sandbox`)) return response({ code: "SANDBOX_NOT_CONFIGURED" }, 409);
		return response({ links: [] });
	}));
});

describe("project settings workspace binding", () => {
	test("keeps an ordinary path-empty project local when no persisted binding exists", async () => {
		const view = render(SettingsPage);
		await waitFor(() => expect(view.getByTestId("sandbox-panel-stub")).toHaveAttribute("data-sandbox", "false"));
		expect(view.getByTestId("project-form-stub")).toBeInTheDocument();
		expect(view.getByTestId("feature-index-stub")).toBeInTheDocument();
		expect(view.getByRole("button", { name: "Delete" })).toBeInTheDocument();
	});

	test("uses the persisted sandbox binding rather than an empty path", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
			if (String(input).endsWith(`/api/projects/${ordinary.id}/incus-feature`)) return response({ kind: "none" });
			if (String(input).endsWith(`/api/projects/${ordinary.id}/sandbox`)) return response({ state: "stopped" });
			return response({ links: [] });
		}));
		const view = render(SettingsPage);
		await waitFor(() => expect(view.getByTestId("sandbox-panel-stub")).toHaveAttribute("data-sandbox", "true"));
		expect(view.queryByTestId("project-form-stub")).not.toBeInTheDocument();
		expect(view.queryByTestId("feature-index-stub")).not.toBeInTheDocument();
		expect(view.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
	});

	test("fails closed while the persisted workspace binding cannot be verified", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
			if (String(input).endsWith(`/api/projects/${ordinary.id}/incus-feature`)) return response({ kind: "none" });
			if (String(input).endsWith(`/api/projects/${ordinary.id}/sandbox`)) return response({ error: "Sandbox service unavailable" }, 503);
			return response({ links: [] });
		}));
		const view = render(SettingsPage);
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Sandbox service unavailable"));
		expect(view.queryByTestId("sandbox-panel-stub")).not.toBeInTheDocument();
		expect(view.queryByTestId("project-form-stub")).not.toBeInTheDocument();
	});

	test("shows only the operator handoff for an Incus-bound project", async () => {
		state.store.projects = [{ ...ordinary, path: "/repo" }];
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
			String(input).endsWith(`/api/projects/${ordinary.id}/incus-feature`)
				? response({ kind: "incus", canManage: true, presetId: "incus-compose-v1", observedState: "STOPPED" }) : response({ links: [] })));
		const view = render(SettingsPage);
		await waitFor(() => expect(view.getByTestId("incus-project-settings")).toBeInTheDocument());
		expect(view.getByRole("link", { name: "Manage Incus sandbox" })).toHaveAttribute("href", "/extensions/incus-management");
		expect(view.getByText(/Preset: incus-compose-v1 · Last observed state: STOPPED/)).toBeInTheDocument();
		expect(view.queryByTestId("sandbox-panel-stub")).not.toBeInTheDocument();
		expect(view.queryByTestId("project-form-stub")).not.toBeInTheDocument();
		expect(view.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
	});

	test("gives a member operator guidance without a forbidden management link", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL) =>
			String(input).endsWith(`/api/projects/${ordinary.id}/incus-feature`)
				? response({ kind: "incus", canManage: false, presetId: "incus-compose-v1", observedState: "STOPPED" }) : response({ links: [] })));
		const view = render(SettingsPage);
		await waitFor(() => expect(view.getByTestId("incus-project-settings")).toBeInTheDocument());
		expect(view.getByText("Ask an administrator to manage this sandbox.")).toBeInTheDocument();
		expect(view.queryByRole("link", { name: "Manage Incus sandbox" })).not.toBeInTheDocument();
	});
});
