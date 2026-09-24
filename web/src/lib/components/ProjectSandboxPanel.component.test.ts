import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

const { goto, refreshProjects } = vi.hoisted(() => ({ goto: vi.fn(), refreshProjects: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("$lib/stores.svelte.js", () => ({ refreshProjects }));
import ProjectSandboxPanel from "./ProjectSandboxPanel.svelte";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); goto.mockReset(); refreshProjects.mockReset(); });

function response(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), { status: ok ? 200 : 409, headers: { "content-type": "application/json" } });
}

describe("ProjectSandboxPanel", () => {
	test("shows reviewed providers and creates a dedicated sandbox project", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(response({ providers: [{ installationId: "install", providerId: "local", label: "Local sandbox", ready: true }] })).mockResolvedValueOnce(response({ project: { id: "sandbox-project" } }));
		vi.stubGlobal("fetch", fetch);
		const view = render(ProjectSandboxPanel, { projectId: "source" });
		await waitFor(() => expect(view.getByRole("button", { name: /Local sandbox.*Create a dedicated sandbox/i })).toBeVisible());
		const order: string[] = [];
		refreshProjects.mockImplementation(async () => { order.push("refresh"); return true; });
		goto.mockImplementation(async () => { order.push("goto"); });
		await fireEvent.click(view.getByRole("button", { name: /Local sandbox.*Create a dedicated sandbox/i }));
		await waitFor(() => expect(goto).toHaveBeenCalledWith("/project/sandbox-project/settings"));
		expect(refreshProjects).toHaveBeenCalledOnce();
		expect(order).toEqual(["refresh", "goto"]);
		expect(fetch).toHaveBeenLastCalledWith("/api/sandboxes", expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ name: "Sandbox for source", providerInstallationId: "install", providerId: "local" }),
		}));
	});

	test("does not navigate when the new project cannot refresh into the store", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(response({ providers: [{ installationId: "install", providerId: "local", label: "Local sandbox", ready: true }] })).mockResolvedValueOnce(response({ project: { id: "sandbox-project" } }));
		vi.stubGlobal("fetch", fetch);
		refreshProjects.mockResolvedValue(false);
		const view = render(ProjectSandboxPanel, { projectId: "source" });
		await waitFor(() => expect(view.getByRole("button", { name: /Local sandbox.*Create a dedicated sandbox/i })).toBeVisible());
		await fireEvent.click(view.getByRole("button", { name: /Local sandbox.*Create a dedicated sandbox/i }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Could not load the new sandbox"));
		expect(goto).not.toHaveBeenCalled();
	});

	test("shows provider absence", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ providers: [] })));
		const view = render(ProjectSandboxPanel, { projectId: "source" });
		await waitFor(() => expect(view.getByText(/No reviewed local sandbox provider/)).toBeVisible());
	});

	test("shows a provider request error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "Provider service is unavailable" }, false)));
		const view = render(ProjectSandboxPanel, { projectId: "source" });
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Provider service is unavailable"));
	});

	test("runs start, stop, and explicit disposal actions", async () => {
		const fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			if (init?.body) return Promise.resolve(response({ state: JSON.parse(String(init.body)).action === "start" ? "running" : "stopped" }));
			return Promise.resolve(response({ state: "stopped" }));
		});
		vi.stubGlobal("fetch", fetch);
		const view = render(ProjectSandboxPanel, { projectId: "sandbox", sandbox: true });
		await waitFor(() => expect(view.getByText("Start")).toBeVisible());
		await fireEvent.click(view.getByText("Start"));
		await waitFor(() => expect(view.getByText("Stop")).not.toBeDisabled());
		await fireEvent.click(view.getByText("Stop"));
		await waitFor(() => expect(view.getByText("Dispose…")).not.toBeDisabled());
		await fireEvent.click(view.getByText("Dispose…"));
		await fireEvent.click(view.getByText("Dispose sandbox"));
		await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url === "/api/projects/sandbox/sandbox" && (init as RequestInit | undefined)?.body === JSON.stringify({ action: "destroy" }))).toBe(true));
		expect(fetch.mock.calls.some(([url, init]) => url === "/api/projects/sandbox/sandbox" && (init as RequestInit | undefined)?.body === JSON.stringify({ action: "start" }))).toBe(true);
		expect(fetch.mock.calls.some(([url]) => String(url).startsWith("/api/local-sandbox/operations/"))).toBe(false);
	});

	test("shows a sandbox action error and keeps the explicit disposal boundary", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(response({ state: "stopped" })).mockResolvedValueOnce(response({ error: "Provider operation failed" }, false));
		vi.stubGlobal("fetch", fetch);
		const view = render(ProjectSandboxPanel, { projectId: "sandbox", sandbox: true });
		await waitFor(() => expect(view.getByText("Dispose…")).toBeVisible());
		await fireEvent.click(view.getByText("Dispose…"));
		expect(view.getByText(/Workspace changes cannot be recovered/)).toBeVisible();
		await fireEvent.click(view.getByText("Dispose sandbox"));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Provider operation failed"));
	});
});


test("disposed workspaces keep history accessible but cannot issue lifecycle commands", async () => {
	const fetch = vi.fn().mockResolvedValue(response({ state: "destroyed" }));
	vi.stubGlobal("fetch", fetch);
	const view = render(ProjectSandboxPanel, { projectId: "sandbox", sandbox: true });
	await waitFor(() => expect(view.getByText("destroyed", { exact: true })).toBeVisible());
	for (const name of ["Start", "Stop", "Dispose…"]) expect(view.getByRole("button", { name })).toBeDisabled();
	expect(view.getByRole("link", { name: "Open chat" })).toHaveAttribute("href", "/project/sandbox");
	expect(fetch).toHaveBeenCalledTimes(1);
});
