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
	await fireEvent.change(view.getByLabelText("Sandbox provider"), { target: { value: "00000000-0000-4000-8000-000000000001" } });
	await fireEvent.click(view.getByRole("button", { name: "Create private sandbox & import" }));
	await waitFor(() => expect(goto).toHaveBeenCalledWith("/project/new-sandbox/settings"));
	expect(fetch).toHaveBeenCalledWith("/api/github/sandboxes", expect.objectContaining({ method: "POST" }));
	expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/sandboxes/new-sandbox/import", expect.objectContaining({ body: expect.stringContaining('"repositoryId":42') }));
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
