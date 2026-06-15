/**
 * DOM tests for AuditLogSection — the /settings/admin/audit log viewer.
 *
 * Coverage:
 *   1. Grouped row renders ×N for a consecutive action+actor run
 *   2. Clicking a row expands pretty-printed JSON details for every
 *      row in the group; clicking again collapses
 *   3. Relative timestamps render with the absolute time in title
 *   4. Filter select refetches with the action query param
 *   5. Load-more appends (passes limit/offset) when a full page returns
 *   6. Relative-time labels live-tick on the 60s interval
 *   7. Mobile audit cards expand to show pretty-printed JSON
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import AuditLogSection from "../settings/AuditLogSection.svelte";

interface Entry {
	id: string;
	userId: string | null;
	action: string;
	target: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

let fetchUrls: string[] = [];

function stubFetch(entries: Entry[] | ((url: URL) => Entry[])) {
	fetchUrls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			fetchUrls.push(url.pathname + url.search);
			const list = typeof entries === "function" ? entries(url) : entries;
			return Response.json({ entries: list, total: list.length });
		}),
	);
}

afterEach(() => vi.unstubAllGlobals());

const HOUR_AGO = new Date(Date.now() - 2 * 3_600_000).toISOString();

function loginRun(): Entry[] {
	return [
		{ id: "e1", userId: "u1", action: "auth:login", target: "alice", metadata: { ip: "1.1.1.1" }, createdAt: HOUR_AGO },
		{ id: "e2", userId: "u1", action: "auth:login", target: "alice", metadata: { ip: "2.2.2.2" }, createdAt: HOUR_AGO },
		{ id: "e3", userId: "u1", action: "auth:login", target: "alice", metadata: { ip: "3.3.3.3" }, createdAt: HOUR_AGO },
		{ id: "e4", userId: "u2", action: "user:invited", target: "bob", metadata: { actor: "system", reason: "version-bump" }, createdAt: HOUR_AGO },
	];
}

describe("AuditLogSection", () => {
	test("collapses a consecutive run into one ×N row", async () => {
		stubFetch(loginRun());
		const { getByTestId, getAllByTestId, queryByText } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-group-e1")).toBeInTheDocument();
		});
		expect(getAllByTestId("audit-group-count")).toHaveLength(1);
		expect(getByTestId("audit-group-count")).toHaveTextContent("×3");
		// Rows e2/e3 are folded into the group — no standalone rows.
		expect(queryByText("2.2.2.2")).not.toBeInTheDocument();
	});

	test("expanding a group shows pretty JSON for every member; collapses on second click", async () => {
		stubFetch(loginRun());
		const { getByTestId, queryByTestId } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-group-e1")).toBeInTheDocument();
		});
		await fireEvent.click(getByTestId("audit-group-e1"));

		const details = getByTestId("audit-group-details");
		expect(details.textContent).toContain('"ip": "1.1.1.1"');
		expect(details.textContent).toContain('"ip": "2.2.2.2"');
		expect(details.textContent).toContain('"ip": "3.3.3.3"');

		await fireEvent.click(getByTestId("audit-group-e1"));
		expect(queryByTestId("audit-group-details")).not.toBeInTheDocument();
	});

	test("single row expands to full (unclipped) pretty JSON", async () => {
		stubFetch(loginRun());
		const { getByTestId } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-group-e4")).toBeInTheDocument();
		});
		await fireEvent.click(getByTestId("audit-group-e4"));

		expect(getByTestId("audit-group-details").textContent).toContain('"reason": "version-bump"');
	});

	test("renders relative time with absolute timestamp in title", async () => {
		stubFetch(loginRun());
		const { getByTestId } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-group-e1")).toBeInTheDocument();
		});
		const timeCell = getByTestId("audit-group-e1").querySelector("td[title]");
		expect(timeCell?.textContent?.trim()).toBe("2h ago");
		expect(timeCell?.getAttribute("title")).toBe(new Date(HOUR_AGO).toLocaleString());
	});

	test("filter select refetches with the action param", async () => {
		stubFetch((url) => {
			const action = url.searchParams.get("action");
			return loginRun().filter((e) => !action || e.action === action);
		});
		const { getByLabelText, getByTestId, queryByTestId } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-group-e1")).toBeInTheDocument();
		});

		await fireEvent.change(getByLabelText("Filter audit events"), { target: { value: "user:invited" } });

		await waitFor(() => {
			expect(queryByTestId("audit-group-e1")).not.toBeInTheDocument();
			expect(getByTestId("audit-group-e4")).toBeInTheDocument();
		});
		expect(fetchUrls.some((u) => u.includes("action=user%3Ainvited") || u.includes("action=user:invited"))).toBe(true);
	});

	test("load-more appears for a full page and appends the next offset", async () => {
		const fullPage: Entry[] = Array.from({ length: 50 }, (_, i) => ({
			id: `p1-${i}`,
			userId: `u${i}`,
			action: "auth:login",
			target: null,
			metadata: null,
			createdAt: HOUR_AGO,
		}));
		stubFetch((url) => (url.searchParams.get("offset") === "0" ? fullPage : []));
		const { getByText, queryByText } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByText("Load more")).toBeInTheDocument();
		});
		await fireEvent.click(getByText("Load more"));

		await waitFor(() => {
			expect(fetchUrls.some((u) => u.includes("offset=50"))).toBe(true);
			expect(queryByText("Load more")).not.toBeInTheDocument();
		});
	});

	test("relative-time labels live-tick on the 60s interval", async () => {
		vi.useFakeTimers();
		try {
			// 30s-old entry so the label starts at "30s ago" and advances.
			const base = Date.now();
			const thirtySecAgo = new Date(base - 30_000).toISOString();
			stubFetch([
				{ id: "t1", userId: "u1", action: "auth:login", target: null, metadata: null, createdAt: thirtySecAgo },
			]);
			const { getByTestId } = render(AuditLogSection);

			await vi.waitFor(() => {
				expect(getByTestId("audit-group-t1")).toBeInTheDocument();
			});
			const timeCell = () => getByTestId("audit-group-t1").querySelector("td[title]");
			expect(timeCell()?.textContent?.trim()).toBe("30s ago");

			// Advance 60s of wall-clock + flush the interval tick. 30s + 60s
			// = 90s, which buckets to the minutes label.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(timeCell()?.textContent?.trim()).toBe("1m ago");
		} finally {
			vi.useRealTimers();
		}
	});

	test("clears the live-tick interval on unmount (no ticking after destroy)", async () => {
		vi.useFakeTimers();
		const clearSpy = vi.spyOn(globalThis, "clearInterval");
		try {
			const thirtySecAgo = new Date(Date.now() - 30_000).toISOString();
			stubFetch([
				{ id: "u1", userId: "u1", action: "auth:login", target: null, metadata: null, createdAt: thirtySecAgo },
			]);
			const { getByTestId, unmount } = render(AuditLogSection);

			await vi.waitFor(() => {
				expect(getByTestId("audit-group-u1")).toBeInTheDocument();
			});
			const label = getByTestId("audit-group-u1").querySelector("td[title]")?.textContent?.trim();
			expect(label).toBe("30s ago");

			unmount();
			// onDestroy must have torn down the 60s interval.
			expect(clearSpy).toHaveBeenCalled();

			// And no further tick fires after teardown: advancing well past
			// the 60s boundary throws nothing and updates no detached node.
			await vi.advanceTimersByTimeAsync(120_000);
		} finally {
			clearSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	test("mobile audit card expands to show pretty JSON; collapses on second tap", async () => {
		stubFetch(loginRun());
		const { getByTestId, queryByTestId } = render(AuditLogSection);

		await waitFor(() => {
			expect(getByTestId("audit-card-e1")).toBeInTheDocument();
		});
		// ×3 marker folded onto the card; collapsed by default.
		expect(getByTestId("audit-card-count-e1")).toHaveTextContent("×3");
		expect(queryByTestId("audit-card-details-e1")).not.toBeInTheDocument();

		await fireEvent.click(getByTestId("audit-card-e1"));
		const details = getByTestId("audit-card-details-e1");
		expect(details.textContent).toContain('"ip": "1.1.1.1"');
		expect(details.textContent).toContain('"ip": "2.2.2.2"');
		expect(details.textContent).toContain('"ip": "3.3.3.3"');

		await fireEvent.click(getByTestId("audit-card-e1"));
		expect(queryByTestId("audit-card-details-e1")).not.toBeInTheDocument();
	});
});
