import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/settings/github?repositoryId=42") } }));
import GithubSettingsPage from "./+page.svelte";

beforeEach(() => sessionStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const deviceAttempt = {
	attemptId: "00000000-0000-4000-8000-000000000001", userCode: "ABCD-EFGH",
	verificationUri: "https://github.com/login/device", expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalSeconds: 1,
};

test("shows the App installation link and rechecks selected repository access", async () => {
	let available = false;
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "connected", configured: true, authMode: "device", account: { id: 123, login: "owner" }, installUrl: "https://github.com/apps/ezcorp-github-auth/installations/new" }
		: url === "/api/github/repositories" ? { repositories: available ? [{ id: 42 }] : [] }
		: { status: "repository_not_enabled", repository: { id: 42, fullName: "owner/private" } })));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("link", { name: "Enable repositories on GitHub" })).toHaveAttribute("href", "https://github.com/apps/ezcorp-github-auth/installations/new"));
	await fireEvent.click(view.getByRole("button", { name: "Recheck repositories" }));
	await waitFor(() => expect(view.getByText("No enabled repositories yet.")).toBeVisible());
	available = true;
	await fireEvent.click(view.getByRole("button", { name: "Recheck repositories" }));
	await waitFor(() => expect(view.getByText("1 enabled repository available.")).toBeVisible());
});

test("device mode shows only the local code and fixed GitHub verification link", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "disconnected", configured: true, authMode: "device" }
		: deviceAttempt)));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH"));
	expect(view.getByRole("link", { name: "Open GitHub verification" })).toHaveAttribute("href", "https://github.com/login/device");
	expect(view.getByRole("link", { name: "Open GitHub verification" })).toHaveAttribute("rel", "noopener noreferrer");
	expect(view.getByText(/Only enter a code that you just requested/)).toBeVisible();
	expect(fetch).toHaveBeenCalledWith("/api/github/device/start", expect.objectContaining({ method: "POST", body: "{}" }));
	expect(fetch).not.toHaveBeenCalledWith("/api/github/authorize", expect.anything());
	expect(sessionStorage.getItem("ezcorp-github-device-attempt")).not.toMatch(/device_code|access_token|refresh_token/);
});

test("device mode rejects a substituted verification address", async () => {
	vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "disconnected", configured: true, authMode: "device" }
		: { ...deviceAttempt, verificationUri: "https://github.com.evil.test/login/device" }))));
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("GitHub returned an invalid device code"));
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
});

test("a device attempt resumes after a reload in the same browser tab", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "disconnected", configured: true, authMode: "device" }
		: url === "/api/github/device/poll" ? { status: "pending", nextPollAt: new Date(Date.now() + 3000).toISOString() } : deviceAttempt)));
	vi.stubGlobal("fetch", fetch);
	const first = render(GithubSettingsPage);
	await waitFor(() => expect(first.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(first.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(first.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH"));
	first.unmount();
	const resumed = render(GithubSettingsPage);
	await waitFor(() => expect(resumed.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH"));
	expect(fetch.mock.calls.filter(([url]) => url === "/api/github/device/start")).toHaveLength(1);
});

test("a saved code stays hidden until this session owns the attempt", async () => {
	sessionStorage.setItem("ezcorp-github-device-attempt", JSON.stringify(deviceAttempt));
	let answerPoll: ((value: Response) => void) | undefined;
	const deferredPoll = new Promise<Response>((resolve) => { answerPoll = resolve; });
	const fetch = vi.fn((url: string) => url === "/api/github/connection"
		? Promise.resolve(response({ status: "disconnected", configured: true, authMode: "device" }))
		: deferredPoll);
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/github/device/poll", expect.objectContaining({ method: "POST" })));
	expect(view.getByText(/Checking your saved GitHub request/)).toBeVisible();
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
	expect(view.queryByRole("link", { name: "Return to PR review" })).not.toBeInTheDocument();
	answerPoll?.(response({ error: "GitHub device authorization is unavailable" }, 404));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Saved GitHub connection request is unavailable"));
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
	expect(sessionStorage.getItem("ezcorp-github-device-attempt")).toBeNull();
});

test("cancelled device authorization removes the code and sends only the attempt ID", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "disconnected", configured: true, authMode: "device" }
		: url === "/api/github/device/cancel" ? { status: "cancelled" } : deviceAttempt)));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByLabelText("GitHub device code")).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Cancel connection" }));
	await waitFor(() => expect(view.getByText("GitHub connection request cancelled.")).toBeVisible());
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
	expect(fetch).toHaveBeenCalledWith("/api/github/device/cancel", expect.objectContaining({ body: JSON.stringify({ attemptId: deviceAttempt.attemptId }) }));
	expect(sessionStorage.getItem("ezcorp-github-device-attempt")).toBeNull();
});

test("a late poll from an older code cannot replace a newer attempt", async () => {
	const newer = { ...deviceAttempt, attemptId: "00000000-0000-4000-8000-000000000003", userCode: "WXYZ-1234" };
	let starts = 0;
	let answerOldPoll: ((value: Response) => void) | undefined;
	const oldPoll = new Promise<Response>((resolve) => { answerOldPoll = resolve; });
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "disconnected", configured: true, authMode: "device" }));
		if (url === "/api/github/device/start") return Promise.resolve(response(++starts === 1 ? deviceAttempt : newer));
		if (url === "/api/github/device/poll") return oldPoll;
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH"));
	await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === "/api/github/device/poll")).toHaveLength(1), { timeout: 2500 });
	await fireEvent.click(view.getByRole("button", { name: "Get a new code" }));
	await waitFor(() => expect(view.getByLabelText("GitHub device code")).toHaveTextContent("WXYZ-1234"));
	answerOldPoll?.(response({ status: "connected" }));
	await oldPoll;
	await tick();
	expect(view.getByLabelText("GitHub device code")).toHaveTextContent("WXYZ-1234");
	expect(sessionStorage.getItem("ezcorp-github-device-attempt")).toContain(newer.attemptId);
	expect(starts).toBe(2);
});

test("a failed single-use exchange clears the code and permits a new request", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/connection"
		? { status: "disconnected", configured: true, authMode: "device" }
		: url === "/api/github/device/poll"
			? { code: "DEVICE_RESTART_REQUIRED", error: "GitHub account lookup failed. Start a new connection." }
			: deviceAttempt, url === "/api/github/device/poll" ? 409 : 200)));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	vi.useFakeTimers();
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await vi.advanceTimersByTimeAsync(0);
	await tick();
	expect(view.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH");
	await vi.advanceTimersByTimeAsync(1000);
	await tick();
	expect(view.getByRole("alert")).toHaveTextContent("GitHub account lookup failed. Start a new connection.");
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
	expect(view.getByRole("button", { name: "Connect GitHub" })).toBeEnabled();
	expect(sessionStorage.getItem("ezcorp-github-device-attempt")).toBeNull();
});

test("a code expires after a failed check without another poll", async () => {
	let polls = 0;
	const fetch = vi.fn((url: string) => {
		if (url === "/api/github/connection") return Promise.resolve(response({ status: "disconnected", configured: true, authMode: "device" }));
		if (url === "/api/github/device/start") return Promise.resolve(response({ ...deviceAttempt, expiresAt: new Date(Date.now() + 5000).toISOString() }));
		if (url === "/api/github/device/poll") { polls++; return Promise.resolve(response({ error: "GitHub check unavailable" }, 503)); }
		throw new Error(`Unexpected URL ${url}`);
	});
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	vi.useFakeTimers();
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await vi.advanceTimersByTimeAsync(0);
	await tick();
	expect(view.getByLabelText("GitHub device code")).toHaveTextContent("ABCD-EFGH");
	await vi.advanceTimersByTimeAsync(1000);
	await tick();
	expect(view.getByText("The connection check failed. You can check again.")).toBeVisible();
	await vi.advanceTimersByTimeAsync(4000);
	await tick();
	expect(view.getByText("The GitHub code expired. Request a new code to try again.")).toBeVisible();
	expect(view.queryByLabelText("GitHub device code")).not.toBeInTheDocument();
	expect(polls).toBe(1);
});

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

test("explicit legacy OAuth rejects an untrusted authorization address", async () => {
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/authorize" ? { authorizeUrl: "https://github.com.evil.test/login/oauth/authorize" } : { status: "disconnected", configured: true, authMode: "oauth" })));
	vi.stubGlobal("fetch", fetch);
	const view = render(GithubSettingsPage);
	await waitFor(() => expect(view.getByRole("button", { name: "Connect GitHub" })).toBeVisible());
	await fireEvent.click(view.getByRole("button", { name: "Connect GitHub" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("GitHub returned an invalid authorization address"));
	expect(fetch).toHaveBeenCalledWith("/api/github/authorize", expect.objectContaining({ method: "POST", body: "{}" }));
});

test("explicit legacy OAuth starts the validated GitHub authorization flow", async () => {
	const assign = vi.fn();
	vi.stubGlobal("window", Object.assign(Object.create(window), { location: { assign } }));
	const fetch = vi.fn((url: string) => Promise.resolve(response(url === "/api/github/authorize" ? { authorizeUrl: "https://github.com/login/oauth/authorize?state=opaque" } : { status: "disconnected", configured: true, authMode: "oauth" })));
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
