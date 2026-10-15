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

function incusReadResponse(url: string) {
		if (url === "/api/github/connection") return response({ status: "connected", configured: true });
		if (url === "/api/github/repositories") return response({ repositories: [
			{ id: 42, fullName: "owner/private", defaultBranch: "main", private: true, accessStatus: "ready" },
		] });
		if (url === "/api/infrastructure/incus/management") return response({ environments: [
			{ installationId: "incus", connectionId: "local", presetId: "small", label: "Private Incus", qualified: true },
			{ installationId: "incus", connectionId: "local", presetId: "blocked", label: "Unqualified Incus", qualified: false },
			{ installationId: "incus", connectionId: "local", presetId: "malformed", label: "Malformed Incus", qualified: "true" },
		], truncated: false });
		return undefined;
}

test("offers only qualified Incus environments without requiring a legacy provider", async () => {
	vi.stubGlobal("fetch", vi.fn((url: string) => {
		const result = incusReadResponse(url);
		if (result) return Promise.resolve(result);
		throw new Error(`Unexpected URL ${url}`);
	}));
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByRole("option", { name: "Private Incus" })).toBeVisible());
	expect(view.queryByRole("option", { name: "Unqualified Incus" })).not.toBeInTheDocument();
	expect(view.queryByRole("option", { name: "Malformed Incus" })).not.toBeInTheDocument();
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "42" } });
	await fireEvent.change(view.getByLabelText("Sandbox provider"), { target: { value: "incus:incus:local:small" } });
	expect(view.getByRole("button", { name: "Create private sandbox & import" })).toBeEnabled();
});

test.each([503, 200])("shows an Incus availability notice without losing GitHub access (status=%s)", async (status) => {
	vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
		url === "/api/infrastructure/incus/management"
			? response({ environments: [], truncated: true }, status)
			: incusReadResponse(url)!,
	)));
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByText(status === 503 ? /Incus environments could not be loaded/ : /More environments are available/)).toBeVisible());
	expect(view.getByRole("option", { name: "owner/private" })).toBeVisible();
	expect(view.getByRole("button", { name: "Create private sandbox & import" })).toBeDisabled();
});

test.each(["unknown", "unavailable", "partial"])("preserves Incus request and recovery rules after %s", async (outcome) => {
	const posts: RequestInit[] = [];
	const fetch = vi.fn((url: string, init?: RequestInit) => {
		const result = incusReadResponse(url);
		if (result) return Promise.resolve(result);
		if (url === "/api/github/sandboxes") {
			posts.push(init!);
			if (posts.length === 1) return Promise.resolve(outcome === "partial"
				? response({ code: "incus_import_partial", error: "Inspect partial import" }, 409)
				: outcome === "unavailable" ? response({ code: "unavailable", error: "Operation outcome unavailable" }, 503)
				: response({ project: { id: "incus-project" }, import: { importState: "unknown" } }, 202));
			return Promise.resolve(response({ project: { id: "incus-project" }, import: { importState: "ready" } }));
		}
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	refreshProjects.mockResolvedValue(true);
	const view = render(GithubSandboxImport, { projectId: "source" });
	await waitFor(() => expect(view.getByRole("option", { name: "Private Incus" })).toBeVisible());
	await fireEvent.change(view.getByLabelText("Repository"), { target: { value: "42" } });
	await fireEvent.change(view.getByLabelText("Sandbox provider"), { target: { value: "incus:incus:local:small" } });
	await fireEvent.click(view.getByRole("button", { name: "Create private sandbox & import" }));
	await waitFor(() => expect(view.getByRole("link", { name: "Inspect saved operation in Incus management" })).toBeVisible());
	expect(goto).not.toHaveBeenCalled();
	expect(view.getByLabelText("Repository")).toBeDisabled();
	expect(view.getByLabelText("Base branch")).toBeDisabled();
	expect(view.getByLabelText("Sandbox provider")).toBeDisabled();
	if (outcome === "partial") {
		expect(view.queryByRole("button", { name: "Retry saved import" })).not.toBeInTheDocument();
		expect(view.getByRole("button", { name: "Source transfer needs review" })).toBeDisabled();
		expect(view.getByText(/This form will not repeat file writes/)).toBeVisible();
		expect(posts).toHaveLength(1);
		return;
	}
	await fireEvent.click(view.getByRole("button", { name: "Retry saved import" }));
	await waitFor(() => expect(goto).toHaveBeenCalledWith("/project/incus-project"));
	expect(posts).toHaveLength(2);
	expect(posts[1]).toEqual(posts[0]);
	expect(JSON.parse(posts[0]!.body as string)).toEqual({ kind: "incus", name: "Sandbox for owner/private", installationId: "incus", connectionId: "local", presetId: "small", repositoryId: 42, baseRef: "main" });
	expect(fetch.mock.calls.some(([url]) => url.includes("/personal-prs/sandboxes/"))).toBe(false);
});

test("creates an owner-only sandbox and imports only an approved repository", async () => {
	const fetch = vi.fn((url: string) => {
		if (url === "/api/infrastructure/incus/management") return Promise.resolve(response({ error: "Admin only" }, 403));
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
		if (url === "/api/infrastructure/incus/management") return Promise.resolve(response({ error: "Admin only" }, 403));
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
