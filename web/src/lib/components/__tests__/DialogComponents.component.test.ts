import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import PublishDialog from "../PublishDialog.svelte";
import FlagDialog from "../FlagDialog.svelte";
import ShareAgentDialog from "../ShareAgentDialog.svelte";
import StuckRunBanner from "../StuckRunBanner.svelte";
import { publishToMarketplace } from "$lib/api.js";
import { addToast } from "$lib/toast.svelte.js";

vi.mock("$lib/api.js", () => ({ publishToMarketplace: vi.fn() }));
vi.mock("$lib/toast.svelte.js", () => ({ addToast: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PublishDialog", () => {
	test("validates semver, normalizes update metadata, and closes after publishing", async () => {
		const onclose = vi.fn();
		const onpublish = vi.fn();
		vi.mocked(publishToMarketplace).mockResolvedValue({ id: "listing-1" } as never);
		render(PublishDialog, { props: { agentConfigId: "agent-1", existingVersion: "1.2.3", open: true, onclose, onpublish } });
		const version = screen.getByLabelText("Version") as HTMLInputElement;
		expect(version.value).toBe("1.2.4");
		await fireEvent.input(version, { target: { value: "invalid" } });
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(screen.getByText("Version must be semver (e.g. 1.0.0)")).toBeTruthy();
		await fireEvent.input(version, { target: { value: " 2.0.0 " } });
		await fireEvent.input(screen.getByLabelText("Changelog"), { target: { value: " Fixed sharing " } });
		await fireEvent.input(screen.getByLabelText(/Tags/), { target: { value: " tools, , quality " } });
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(publishToMarketplace).toHaveBeenCalledWith("agent-1", {
			version: "2.0.0", changelog: "Fixed sharing", tags: ["tools", "quality"],
		}));
		expect(onpublish).toHaveBeenCalledWith({ id: "listing-1" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("shows an API failure and supports cancel and Escape", async () => {
		const onclose = vi.fn();
		vi.mocked(publishToMarketplace).mockRejectedValue(new Error("Release already exists"));
		render(PublishDialog, { props: { agentConfigId: "agent-1", open: true, onclose, onpublish: vi.fn() } });
		await fireEvent.input(screen.getByLabelText("Version"), { target: { value: "" } });
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(screen.getByText("Version is required")).toBeTruthy());
		await fireEvent.input(screen.getByLabelText("Version"), { target: { value: "1.0.0" } });
		await fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		await waitFor(() => expect(screen.getByText("Release already exists")).toBeTruthy());
		await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});

describe("FlagDialog", () => {
	test("submits a trimmed categorized report, then resets and closes", async () => {
		const onclose = vi.fn();
		const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		render(FlagDialog, { props: { listingId: "list-1", open: true, onclose } });
		const submit = screen.getByRole("button", { name: "Submit Report" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		await fireEvent.change(screen.getByLabelText("Category"), { target: { value: "malicious" } });
		await fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "  suspicious payload  " } });
		await fireEvent.click(submit);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/marketplace/list-1/flag");
		expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ category: "malicious", reason: "suspicious payload" });
		expect(addToast).toHaveBeenCalledWith({ type: "success", message: "Listing flagged for review" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("closes on the rate limit and retains API and network failure feedback", async () => {
		const onclose = vi.fn();
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(json({}, 429))
			.mockResolvedValueOnce(json({ error: "Already flagged" }, 400))
			.mockRejectedValueOnce(new Error("offline"));
		vi.stubGlobal("fetch", fetchMock);
		render(FlagDialog, { props: { listingId: "list-1", open: true, onclose } });
		const reason = screen.getByLabelText("Reason");
		for (const expected of ["You've reached the flag limit. Try again later.", "Already flagged", "Failed to flag listing"]) {
			await fireEvent.input(reason, { target: { value: "reason" } });
			await fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
			await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ message: expected })));
		}
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});

describe("ShareAgentDialog", () => {
	test("loads shares, finds a user, grants edit access, and removes a share", async () => {
		let shares = [{ id: "share-1", teamId: null, teamName: null, userId: "u-1", recipientName: "Avery", permission: "read", sharedBy: "admin", sharedByName: "Admin", createdAt: "2026-01-01" }];
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("/users/search")) return json({ users: [{ id: "u-2", name: "Robin", email: "r@example.test" }] });
			if (init?.method === "POST") {
				shares.push({ ...shares[0]!, id: "share-2", userId: "u-2", recipientName: "Robin", permission: "edit" });
				return json({ ok: true });
			}
			if (init?.method === "DELETE") {
				const body = JSON.parse(String(init.body)) as { userId: string };
				shares = shares.filter(share => share.userId !== body.userId);
				return json({ ok: true });
			}
			return json({ shares });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(ShareAgentDialog, { props: { agentId: "agent-1", agentName: "Writer", open: true, onclose: vi.fn() } });
		await waitFor(() => expect(screen.getByText("Avery")).toBeTruthy());
		await fireEvent.input(screen.getByLabelText("Username or email"), { target: { value: " robin@example.test " } });
		await fireEvent.click(screen.getByRole("button", { name: "Can edit" }));
		await fireEvent.click(screen.getByRole("button", { name: "Share" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent-1/share", expect.objectContaining({ method: "POST" })));
		const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
		expect(JSON.parse(post[1]!.body as string)).toEqual({ userIds: ["u-2"], permission: "edit" });
		await waitFor(() => expect(screen.getByText("Robin")).toBeVisible());
		expect(screen.getByLabelText("Username or email")).toHaveValue("");
		expect(screen.queryByRole("button", { name: "Sharing..." })).toBeNull();
		const originalRow = screen.getByText("Avery").parentElement!.parentElement!;
		await fireEvent.click(within(originalRow).getByRole("button", { name: "Remove share" }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/agents/agent-1/share", expect.objectContaining({ method: "DELETE" })));
		await waitFor(() => expect(screen.queryByText("Avery")).toBeNull());
		expect(screen.getByText("Robin")).toBeVisible();
		expect(addToast).toHaveBeenLastCalledWith({ type: "success", message: "Share removed" });
	});

	test("keeps sharing failures visible as toasts and closes from the dialog", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ shares: [] })).mockResolvedValueOnce(json({ shares: [] })).mockResolvedValueOnce(json({ users: [] })));
		const onclose = vi.fn();
		render(ShareAgentDialog, { props: { agentId: "agent-1", agentName: "Writer", open: true, onclose } });
		await fireEvent.input(screen.getByLabelText("Username or email"), { target: { value: "missing" } });
		await fireEvent.keyDown(screen.getByLabelText("Username or email"), { key: "Enter" });
		await waitFor(() => expect(addToast).toHaveBeenCalledWith({ type: "error", message: "User not found" }));
		await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});

describe("StuckRunBanner", () => {
	test("renders slow and stuck guidance with live elapsed time and actions", async () => {
		vi.useFakeTimers();
		const onCancel = vi.fn();
		const onOpenObservability = vi.fn();
		render(StuckRunBanner, { props: { stalenessMs: 30_000, startedAt: Date.now() - 61_000, onCancel, onOpenObservability } });
		expect(screen.getByRole("status").textContent).toContain("silent for 30s");
		expect(screen.getByRole("status").textContent).toContain("Total elapsed: 1m1s");
		await fireEvent.click(screen.getByRole("button", { name: "View details" }));
		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenObservability).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(screen.getByRole("status").textContent).toContain("Total elapsed: 1m2s");
	});

	test("marks the sixty-second threshold as stuck", () => {
		render(StuckRunBanner, { props: { stalenessMs: 60_000, startedAt: Date.now(), onCancel: vi.fn(), onOpenObservability: vi.fn() } });
		expect(screen.getByRole("status").textContent).toContain("may be stuck");
		expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("bg-red-600");
	});
});

describe("ShareAgentDialog failure and ownership paths", () => {
	test("reports rejected lookup, rejected share, failed removal, and returns permission to read", async () => {
		const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
			if (init?.method === "DELETE") return json({}, 500);
			if (init?.method === "POST") return json({ error: "Policy denied" }, 403);
			if (input.includes("/users/search")) return json({}, 500);
			return json({ shares: [{ id: "team-share", teamId: "team-1", teamName: "Research", userId: null, recipientName: null, permission: "edit", sharedBy: "admin", sharedByName: "Admin", createdAt: "2026-01-01" }] });
		});
		vi.stubGlobal("fetch", fetchMock);
		render(ShareAgentDialog, { props: { agentId: "agent-1", agentName: "Writer", open: true, onclose: vi.fn() } });
		await waitFor(() => expect(screen.getByText("Research")).toBeTruthy());
		await fireEvent.click(screen.getByRole("button", { name: "Can use" }));
		await fireEvent.input(screen.getByLabelText("Username or email"), { target: { value: "unknown" } });
		await fireEvent.click(screen.getByRole("button", { name: "Share" }));
		await waitFor(() => expect(addToast).toHaveBeenCalledWith({ type: "error", message: "User not found" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove share" }));
		await waitFor(() => expect(addToast).toHaveBeenCalledWith({ type: "error", message: "Failed to remove share" }));
	});
});
