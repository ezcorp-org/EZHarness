import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/settings/github?repositoryId=42") } }));
import GithubSettingsPage from "./+page.svelte";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("shows personal disconnected state and never asks for a token", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: "disconnected", configured: true })));
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	expect(view.getByText("No GitHub account connected.")).toBeVisible();
	expect(view.queryByLabelText(/token/i)).not.toBeInTheDocument();
});

test("shows repository approval for connected owner and disconnects locally", async () => {
	const fetch = vi.fn((url: string, init?: RequestInit) => {
		if (url === "/api/github/connection" && init?.method === "DELETE") return Promise.resolve(response({ status: "disconnected", configured: true }));
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }));
		if (url === "/api/github/repositories/check?repositoryId=42") return Promise.resolve(response({ status: "repository_not_enabled", repository: { id: 42, fullName: "org/private" } }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByText("Enable this repository for the GitHub App.")).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: /^Disconnect$/ }));
	expect(view.getByText(/Pending draft pull requests will stop/)).toBeVisible();
	await fireEvent.click(view.getByRole("button", { name: "Disconnect GitHub" }));
	await waitFor(() => expect(view.getByText("No GitHub account connected.")).toBeVisible());
	expect(fetch).toHaveBeenCalledWith("/api/github/connection", { method: "DELETE" });
});

test("shows reconnect required without a publication action", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: "reconnect_required", configured: true, account: { id: 123, login: "owner-a" } })));
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByText("Reconnect required. Draft pull requests are paused.")).toBeVisible());
	expect(view.getByRole("button", { name: "Reconnect" })).toBeVisible();
	expect(view.queryByRole("button", { name: "Create draft PR" })).not.toBeInTheDocument();
});

test("an approval request remains pending until GitHub reports repository ready", async () => {
	let checks = 0;
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }));
		if (url === "/api/github/repositories/check?repositoryId=42") return Promise.resolve(response({ status: ++checks === 1 ? "repository_not_enabled" : "ready", repository: { id: 42, fullName: "org/private" } }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByText("Enable this repository for the GitHub App.")).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "I requested approval" }));
	expect(view.getByText("Approval may be pending. GitHub has not enabled this repository yet.")).toBeVisible();
	await fireEvent.click(view.getByRole("button", { name: "Recheck access" }));
	await waitFor(() => expect(view.getByText("Ready for private sandbox import and draft pull requests.")).toBeVisible());
	expect(checks).toBe(2);
});

test("explains server setup and connection load failures", async () => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ status: "disconnected", configured: false })));
	const unconfigured = render(GithubSettingsPage);
	await waitFor(() => expect(unconfigured.getByText(/not configured on this EZCorp server/)).toBeVisible());
	unconfigured.unmount();
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "unavailable" }, 503)));
	const failed = render(GithubSettingsPage);
	await waitFor(() => expect(failed.getByText(/Could not load your GitHub connection/)).toBeVisible());
	expect(failed.getByRole("alert")).toHaveTextContent("unavailable");
});

test("shows repository check errors and missing write permission", async () => {
	let failCheck = true;
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "connected", configured: true, account: { id: 123, login: "owner-a" } }));
		if (url === "/api/github/repositories/check?repositoryId=42") return Promise.resolve(failCheck ? response({ error: "Could not check repository access" }, 503) : response({ status: "insufficient_user_permission", repository: { id: 42, fullName: "org/private" } }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Could not check repository access"));
	view.unmount();
	failCheck = false;
	const limited = render(GithubSettingsPage);
	await waitFor(() => expect(limited.getByText("Your account needs repository write access.")).toBeVisible());
});

test("asks for reconnection when repository access cannot be checked", async () => {
	vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection" ? { status: "connected", configured: true } : { status: "reconnect_required", repository: { id: 42, fullName: "org/private" } }))));
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByText("Reconnect your GitHub account to check this repository.")).toBeVisible());
});

test("connect rejects an untrusted authorization address", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/authorize" ? { authorizeUrl: "https://github.com.evil.test/login/oauth/authorize" } : { status: "disconnected", configured: true })));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("GitHub returned an invalid authorization address"));
	expect(fetch).toHaveBeenCalledWith("/api/github/authorize", expect.objectContaining({ method: "POST", body: "{}" }));
});

test("connect starts the validated GitHub authorization flow", async () => {
	const assign = vi.fn();
	vi.stubGlobal("window", Object.assign(Object.create(window), { location: { assign } }));
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/authorize" ? { authorizeUrl: "https://github.com/login/oauth/authorize?state=opaque" } : { status: "disconnected", configured: true })));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=opaque"));
	expect(fetch).toHaveBeenCalledWith("/api/github/authorize", expect.objectContaining({ method: "POST" }));
});

test("disconnect errors keep the current connected account visible", async () => {
	const fetch = vi.fn((url: string, init?: RequestInit) => Promise.resolve(response(init?.method === "DELETE" ? { error: "Could not disconnect GitHub" } : url === "/api/github/repositories/check?repositoryId=42" ? { status: "ready", repository: { id: 42, fullName: "owner/repo" } } : { status: "connected", configured: true, account: { id: 123, login: "owner-a" } }, init?.method === "DELETE" ? 503 : 200)));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: /^Disconnect$/ })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: /^Disconnect$/ }));
	await fireEvent.click(view.getByRole("button", { name: "Disconnect GitHub" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Could not disconnect GitHub"));
	expect(view.getByText("owner-a", { exact: true })).toBeVisible();
});
