import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

const { goto, refreshProjects } = vi.hoisted(() => ({ goto: vi.fn(), refreshProjects: vi.fn() }));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("$lib/stores.svelte.js", () => ({ refreshProjects }));
import GithubSandboxImport from "./GithubSandboxImport.svelte";

afterEach(() => { vi.unstubAllGlobals(); goto.mockReset(); refreshProjects.mockReset(); });

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("creates an owner-only sandbox and imports only an approved repository", async () => {
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true }));
		if (url === "/api/github/repositories") return Promise.resolve(response({ repositories: [
			{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" },
			{ id: 43, fullName: "owner/no-write", defaultBranch: "main", private: true, accessStatus: "insufficient_user_permission" },
		] }));
		if (url === "/api/github/sandboxes") return Promise.resolve(response({ project: { id: "new-sandbox" } }, 201));
		if (url === "/api/github/personal-prs/sandboxes/new-sandbox/import") return Promise.resolve(response({ projectId: "new-sandbox", importState: "ready" }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	refreshProjects.mockResolvedValue(true);
	const view = render(GithubSandboxImport, { projectId: "source", providers: [{ installationId: "00000000-0000-4000-8000-000000000001", providerId: "local", label: "Local", ready: true }] });
	await waitFor(() => expect(view.getByRole("option", { name: "owner/private" })).toBeVisible());
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "43" } });
	expect(view.getByRole("button", { name: "Create private sandbox & import" })).toBeDisabled();
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "42" } });
	await waitFor(() => expect(view.getByLabelText("Base branch")).toHaveValue("main"));
	await fireEvent.input(view.getByLabelText("Base branch"), { target: { value: "release/1.x" } });
	await fireEvent.change(view.getByLabelText("Sandbox provider"), { target: { value: "00000000-0000-4000-8000-000000000001" } });
	await fireEvent.click(view.getByRole("button", { name: "Create private sandbox & import" }));
	await waitFor(() => expect(goto).toHaveBeenCalledWith("/project/new-sandbox/settings"));
	expect(fetch).toHaveBeenCalledWith("/api/github/sandboxes", expect.objectContaining({ method: "POST" }));
	expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/sandboxes/new-sandbox/import", expect.objectContaining({ body: expect.stringContaining('"repositoryId":42') }));
	expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/sandboxes/new-sandbox/import", expect.objectContaining({ body: expect.stringContaining('"baseRef":"release/1.x"') }));
});

test("pending private sandbox imports without creating a second project", async () => {
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true }));
		if (url === "/api/github/repositories") return Promise.resolve(response({ repositories: [{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" }] }));
		if (url === "/api/github/personal-prs/sandboxes/pending/import") return Promise.resolve(response({ importState: "ready" }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	refreshProjects.mockResolvedValue(true);
	const onimported = vi.fn();
	const view = render(GithubSandboxImport, { projectId: "pending", pendingPrivate: true, onimported });
	await waitFor(() => expect(view.getByLabelText("Repository")).toBeVisible());
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "42" } });
	await fireEvent.click(view.getByRole("button", { name: "Import into this sandbox" }));
	await waitFor(() => expect(onimported).toHaveBeenCalledOnce());
	expect(fetch.mock.calls.some(([url]) => url === "/api/github/sandboxes")).toBe(false);
});

test("shows connection errors without offering an import", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "unavailable" }, 503)));
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Could not load GitHub repositories"));
	expect(view.queryByRole("button", { name: "Create private sandbox & import" })).not.toBeInTheDocument();
});

test.each([
	["disconnected", "Connect GitHub"],
	["reconnect_required", "Reconnect GitHub"],
])("directs a %s account to the right setup action", async (status, label) => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status, configured: true })));
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByRole("link", { name: label })).toHaveAttribute("href", "/settings/github"));
});

test("explains when no approved repositories can be imported", async () => {
	vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection" ? { status: "connected", configured: true, installUrl: "https://github.com/apps/ezcorp-github-auth/installations/new" } : { repositories: [] }))));
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByText(/No enabled repositories are available/)).toBeVisible());
	expect(view.getByRole("link", { name: "Enable repositories on GitHub" })).toHaveAttribute("href", "https://github.com/apps/ezcorp-github-auth/installations/new");
});

test("keeps an admitted private sandbox visible when import fails", async () => {
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true }));
		if (url === "/api/github/repositories") return Promise.resolve(response({ repositories: [{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" }] }));
		if (url === "/api/github/sandboxes") return Promise.resolve(response({ project: { id: "new-sandbox" } }, 201));
		if (url === "/api/github/personal-prs/sandboxes/new-sandbox/import") return Promise.resolve(response({ error: "Import failed" }, 503));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSandboxImport, { projectId: "source", providers: [{ installationId: "00000000-0000-4000-8000-000000000001", providerId: "local", label: "Local", ready: true }] });
	await waitFor(() => expect(view.getByLabelText("Repository")).toBeVisible());
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "42" } });
	await fireEvent.change(view.getByLabelText("Sandbox provider"), { target: { value: "00000000-0000-4000-8000-000000000001" } });
	await fireEvent.click(view.getByRole("button", { name: "Create private sandbox & import" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Import failed"));
	expect(view.getByRole("link", { name: "Open the private sandbox" })).toHaveAttribute("href", "/project/new-sandbox/settings");
});
