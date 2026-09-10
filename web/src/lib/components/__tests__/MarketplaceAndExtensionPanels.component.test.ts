import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import ExtensionPanel from "../ExtensionPanel.svelte";
import MarketplaceDetail from "../MarketplaceDetail.svelte";
import { readExtPanel, writeExtPanel } from "$lib/panel-persistence.js";

vi.mock("$lib/panel-persistence.js", () => ({ readExtPanel: vi.fn(), writeExtPanel: vi.fn() }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const listing = {
	id: "listing-1", name: "Research helper", description: "**Useful** agent", authorName: "Avery",
	category: "research", latestVersion: "2.0.0", installCount: 12, ratingTotal: 2, ratingPercent: 75, status: "flagged",
} as any;
const versions = [{ id: "v2", version: "2.0.0", createdAt: "2026-01-02T00:00:00.000Z", changelog: "Improved imports", manifest: {
	agent: { exampleConversations: [{ title: "Research flow", messages: [{ role: "user", content: "Find sources" }, { role: "assistant", content: "Here are sources" }] }] },
	extensions: [{ name: "Web", source: "builtin", version: "1.0.0", required: true }],
}}] as any;

describe("ExtensionPanel", () => {
	test("renders every supported panel component and persists collapse state", async () => {
		vi.mocked(readExtPanel).mockReturnValue(undefined);
		const state = { title: "Run status", components: [
			{ type: "header", title: "Plan", subtitle: "Current work" },
			{ type: "text", content: "Important note", variant: "emphasis" },
			{ type: "text", content: "Muted note", variant: "muted" },
			{ type: "badge", label: "Ready", color: "green" },
			{ type: "progress", label: "Progress", value: 55.5 },
			{ type: "status", label: "Running", state: "running" },
			{ type: "list", items: [{ label: "Queued", status: "pending" }, { label: "Done", status: "completed", detail: "Saved", badge: "new", badgeColor: "purple" }, { label: "Broken", status: "failed" }, { label: "Now", status: "active" }] },
			{ type: "kv", pairs: [{ key: "Model", value: "fast" }] },
			{ type: "counter", label: "Files", value: 4, total: 3 },
			{ type: "counter", label: "Attempts", value: 2 },
			{ type: "divider" },
		] };
		render(ExtensionPanel, { props: { extensionId: "ext-1", extensionName: "Planner", conversationId: "conv-1", state } });
		expect(screen.getByRole("button", { name: "Collapse extension panel" })).toBeTruthy();
		for (const text of ["Plan", "Current work", "Important note", "Muted note", "Ready", "Progress", "56%", "Running", "Queued", "Done", "Saved", "Broken", "Now", "Model", "fast", "Files", "4/3", "Attempts", "2"]) expect(screen.getByText(text, { exact: true })).toBeTruthy();
		expect(document.body.textContent).toContain("11 items");
		expect(writeExtPanel).toHaveBeenCalledWith("conv-1", "ext-1", { expanded: true });
		await fireEvent.click(screen.getByRole("button", { name: "Collapse extension panel" }));
		expect(screen.getByRole("button", { name: "Expand extension panel" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Expand extension panel" })).toBeTruthy();
		expect(writeExtPanel).toHaveBeenLastCalledWith("conv-1", "ext-1", { expanded: false });
	});

	test("honors stored collapsed state and rejects malformed extension data", () => {
		vi.mocked(readExtPanel).mockReturnValue({ expanded: false });
		const { rerender } = render(ExtensionPanel, { props: { extensionId: "ext-1", extensionName: "Planner", conversationId: "conv-1", state: { title: "Safe", components: [] } } });
		expect(screen.getByRole("button", { name: "Expand extension panel" })).toBeTruthy();
		rerender({ extensionId: "ext-1", extensionName: "Planner", conversationId: "conv-1", state: { title: 4, components: "not-an-array" } as any });
		expect(screen.queryByRole("button", { name: /extension panel/ })).toBeNull();
	});
});

describe("MarketplaceDetail", () => {
	test("lets a marketplace visitor install, rate, export, report, and inspect all content tabs", async () => {
		const oninstall = vi.fn(), onrate = vi.fn(), onflag = vi.fn(), onexport = vi.fn();
		render(MarketplaceDetail, { props: { listing, versions, userRating: true, oninstall, onrate, onflag, onexport } });
		expect(screen.getByText("75%")).toBeTruthy();
		expect(screen.getByText("Required Extensions")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Install" }));
		await fireEvent.click(screen.getByTitle("Thumbs down"));
		await fireEvent.click(screen.getByRole("button", { name: "Export" }));
		await fireEvent.click(screen.getByRole("button", { name: "Report" }));
		expect(oninstall).toHaveBeenCalledTimes(1); expect(onrate).toHaveBeenCalledWith(false); expect(onexport).toHaveBeenCalledTimes(1); expect(onflag).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByRole("button", { name: "Versions (1)" }));
		expect(screen.getByText("Improved imports")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Examples" }));
		expect(screen.getByText("Research flow")).toBeTruthy();
		expect(screen.getByText("Find sources")).toBeTruthy();
	});

	test("exposes author and administrator controls and empty version/rating states", async () => {
		const onupdate = vi.fn(), ondismissflag = vi.fn(), onremove = vi.fn();
		const { rerender } = render(MarketplaceDetail, { props: { listing: { ...listing, ratingTotal: 0 }, isAuthor: true, oninstall: vi.fn(), onrate: vi.fn(), onflag: vi.fn(), onexport: vi.fn(), onupdate } });
		expect(screen.getByText("This listing has been flagged for review")).toBeTruthy();
		expect(screen.getByText("No ratings yet")).toBeTruthy();
		await fireEvent.click(screen.getByRole("button", { name: "Update Version" }));
		expect(onupdate).toHaveBeenCalledTimes(1);
		rerender({ listing, isAdmin: true, oninstall: vi.fn(), onrate: vi.fn(), onflag: vi.fn(), onexport: vi.fn(), ondismissflag, onremove });
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss Flag" }));
		await fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(ondismissflag).toHaveBeenCalledTimes(1); expect(onremove).toHaveBeenCalledTimes(1);
		await fireEvent.click(screen.getByRole("button", { name: "Versions (0)" }));
		expect(screen.getByText("No version history available.")).toBeTruthy();
	});
});
