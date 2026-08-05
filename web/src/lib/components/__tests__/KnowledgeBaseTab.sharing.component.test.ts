/**
 * DOM tests for `KnowledgeBaseTab.svelte` — the sharing controls, plus the
 * fetch-loop regression the work on them uncovered.
 *
 * ## What is being pinned
 *
 * 1. **The buttons come from the SERVER.** `canShare` / `canUnshare` arrive on
 *    each row from `GET /api/knowledge-base`, which derives them with the same
 *    module the share route enforces with (`src/memory/kb-sharing.ts`). The
 *    component must render them and never re-derive the rule — it cannot, since
 *    it knows neither the caller's id nor their project membership. A row with
 *    both flags false gets the badge and no verb.
 *
 * 2. **The re-read is a full re-fetch.** Un-sharing restores an owner, which
 *    changes the affordances of rows other than the one clicked, so merging the
 *    single response into the clicked row would leave the rest of the table
 *    lying. The component re-lists instead.
 *
 * 3. **The mount effect fires ONCE.** This is a regression pin, not a nicety.
 *    `fetchFiles` reads `files.length` synchronously (before its first `await`)
 *    to decide whether to show the spinner, which made `files` a dependency of
 *    the mount `$effect`; the same call then assigns a fresh array to `files`,
 *    invalidating the effect and re-running it — an unbounded request loop,
 *    measured at ~1800 `GET /api/knowledge-base` calls in four seconds for as
 *    long as the tab was open. `untrack` around the call is the fix, and the
 *    last test here fails without it.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import KnowledgeBaseTab from "../KnowledgeBaseTab.svelte";

interface Row {
	id: string;
	projectId: string;
	orgScoped: boolean;
	filename: string;
	mimeType: string;
	fileSize: number;
	chunkCount: number;
	status: string;
	createdAt: string;
	shared?: boolean;
	sharedByYou?: boolean;
	canShare?: boolean;
	canUnshare?: boolean;
}

function row(overrides: Partial<Row> = {}): Row {
	return {
		id: "kb-1",
		projectId: "proj-1",
		orgScoped: false,
		filename: "handbook.md",
		mimeType: "text/markdown",
		fileSize: 2048,
		chunkCount: 3,
		status: "ready",
		createdAt: new Date().toISOString(),
		shared: false,
		sharedByYou: false,
		canShare: true,
		canUnshare: false,
		...overrides,
	};
}

/** Serve the list, and record every call so the loop pin can count them. */
function stubApi(opts: {
	list: () => Row[];
	share?: (method: string) => Response;
}) {
	const calls: string[] = [];
	const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
		const href = String(url);
		const method = init?.method ?? "GET";
		calls.push(`${method} ${href}`);
		if (href.includes("/share")) {
			return opts.share
				? opts.share(method)
				: new Response(JSON.stringify({}), { status: 200 });
		}
		return new Response(JSON.stringify(opts.list()), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { calls, listCalls: () => calls.filter((c) => !c.includes("/share")) };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("sharing affordances are rendered from the server's answer", () => {
	test("a file you may share offers Share and carries no badge", async () => {
		stubApi({ list: () => [row()] });
		const { findByText, queryByText, getByRole } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});

		await findByText("handbook.md");
		expect(getByRole("button", { name: "Share" })).toBeTruthy();
		expect(queryByText("Shared by you")).toBeNull();
		expect(queryByText("Shared")).toBeNull();
	});

	test("a file you shared is badged 'Shared by you' and offers Unshare", async () => {
		stubApi({
			list: () => [row({ shared: true, sharedByYou: true, canShare: false, canUnshare: true })],
		});
		const { findByText, getByRole, queryByRole } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});

		await findByText("Shared by you");
		expect(getByRole("button", { name: "Unshare" })).toBeTruthy();
		expect(queryByRole("button", { name: "Share" })).toBeNull();
	});

	test("someone else's shared file is badged 'Shared' and offers NO verb", async () => {
		// The authorization rule as the UI must render it. A visible button here
		// would be one the server refuses — the affordance must match the gate.
		stubApi({
			list: () => [row({ shared: true, sharedByYou: false, canShare: false, canUnshare: false })],
		});
		const { findByText, queryByRole, getByRole } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});

		await findByText("Shared");
		expect(queryByRole("button", { name: "Share" })).toBeNull();
		expect(queryByRole("button", { name: "Unshare" })).toBeNull();
		// Delete is unaffected by sharing and stays.
		expect(getByRole("button", { name: "Delete" })).toBeTruthy();
	});
});

describe("the share round trip", () => {
	test("Share POSTs to the file's share path and re-lists", async () => {
		let shared = false;
		const api = stubApi({
			list: () => [
				row(
					shared
						? { shared: true, sharedByYou: true, canShare: false, canUnshare: true }
						: {},
				),
			],
		});
		const { findByText, getByRole } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});
		await findByText("handbook.md");

		shared = true;
		await fireEvent.click(getByRole("button", { name: "Share" }));

		await waitFor(() => expect(api.calls).toContain("POST /api/knowledge-base/kb-1/share"));
		// A full re-list, not a merge of the single response — un-sharing changes
		// the affordances of OTHER rows, so the whole table must be re-read.
		await findByText("Shared by you");
		expect(api.listCalls().length).toBeGreaterThanOrEqual(2);
	});

	test("Unshare DELETEs the same path", async () => {
		let shared = true;
		const api = stubApi({
			list: () => [
				row(
					shared
						? { shared: true, sharedByYou: true, canShare: false, canUnshare: true }
						: {},
				),
			],
		});
		const { findByText, getByRole } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});
		await findByText("Shared by you");

		shared = false;
		await fireEvent.click(getByRole("button", { name: "Unshare" }));

		await waitFor(() => expect(api.calls).toContain("DELETE /api/knowledge-base/kb-1/share"));
		await findByText("handbook.md");
		expect(getByRole("button", { name: "Share" })).toBeTruthy();
	});

	test("a refusal surfaces the server's message and does not claim success", async () => {
		stubApi({
			list: () => [row()],
			share: () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		});
		const { findByText, getByRole, getByTestId, queryByText } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});
		await findByText("handbook.md");

		await fireEvent.click(getByRole("button", { name: "Share" }));

		await waitFor(() => expect(getByTestId("kb-share-error").textContent).toBe("Forbidden"));
		expect(queryByText("Shared by you")).toBeNull();
	});

	test("a refusal with no parseable body still says something", async () => {
		stubApi({
			list: () => [row()],
			share: () => new Response("not json", { status: 500 }),
		});
		const { findByText, getByRole, getByTestId } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});
		await findByText("handbook.md");

		await fireEvent.click(getByRole("button", { name: "Share" }));
		await waitFor(() =>
			expect(getByTestId("kb-share-error").textContent).toBe(
				"Could not change sharing for this file.",
			),
		);
	});

	test("a transport failure is reported, not swallowed", async () => {
		const fetchMock = vi.fn(async (url: unknown) => {
			if (String(url).includes("/share")) throw new Error("offline");
			return new Response(JSON.stringify([row()]), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const { findByText, getByRole, getByTestId } = render(KnowledgeBaseTab, {
			props: { projectId: "proj-1" },
		});
		await findByText("handbook.md");

		await fireEvent.click(getByRole("button", { name: "Share" }));
		await waitFor(() =>
			expect(getByTestId("kb-share-error").textContent).toBe("Could not reach the server."),
		);
	});
});

describe("REGRESSION: mounting the tab issues ONE list request, not a loop", () => {
	test("the list is fetched once and stays fetched once", async () => {
		// Without `untrack` in the mount effect this climbs into the hundreds
		// before the assertion runs: `fetchFiles` reads `files.length`
		// synchronously, then writes a fresh `files` array, so the effect
		// invalidates itself forever. All rows are `ready`, so the 3s status
		// poll is not running and every call here would be spurious.
		const api = stubApi({ list: () => [row()] });
		const { findByText } = render(KnowledgeBaseTab, { props: { projectId: "proj-1" } });
		await findByText("handbook.md");

		await settle();
		expect(api.listCalls()).toEqual(["GET /api/knowledge-base?projectId=proj-1"]);
	});
});
