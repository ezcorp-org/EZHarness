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
		if (url === "/api/github/repositories/check?repositoryId=42") return Promise.resolve(response({ status: "organization_approval_pending", repository: { id: 42, fullName: "org/private" } }));
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByText("Your organization must approve the GitHub App.")).toBeVisible());
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
