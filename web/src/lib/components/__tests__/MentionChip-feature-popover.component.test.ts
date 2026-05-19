/**
 * DOM tests for the `$feature` chip's hover popover behavior in
 * MentionChip.svelte. Distinct from `MentionChip.component.test.ts`
 * (sigil regression) — this file pins:
 *
 *   - hover triggers the two-step list+detail fetch
 *   - popover header / description / file-tree rendering
 *   - "no active project" → no fetch, fallback render
 *   - loading and unavailable states
 *   - 80ms deferred close (cursor → popover → still mounted)
 *   - 500ms mobile tap-and-hold opens + pins
 *   - touch-move / touch-end before threshold cancels the hold
 *   - document tap-outside dismisses a pinned popover
 *   - contextmenu suppression on hover-capable chips
 *
 * Fetch is stubbed at `globalThis.fetch`; `_resetFeatureDetailsCache`
 * makes each test independent. Real timers are used throughout so we
 * don't have to juggle vi.useFakeTimers around async fetches — the
 * 80ms / 500ms thresholds are short enough to wait through with
 * `waitFor`.
 */
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import MentionChip from "../MentionChip.svelte";
import { _resetFeatureDetailsCache } from "$lib/api";
import { store } from "$lib/stores.svelte";

const PROJECT_ID = "proj-1";
const FEATURE_NAME = "chat";
const FEATURE_ID = "feat-chat";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function stubFetch(handler: FetchHandler) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string"
					? input
					: ((input as Request).url ?? input.toString());
			return handler(url, init);
		}),
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const LIST = (pid: string) => `/api/projects/${pid}/features`;
const DETAIL = (pid: string, fid: string) => `/api/projects/${pid}/features/${fid}`;
const POPOVER_SEL = `[data-feature-popover="${FEATURE_NAME}"]`;

function defaultHappyPathHandler(opts?: {
	files?: { relpath: string; source: "scan" | "user" }[];
	description?: string;
}): FetchHandler {
	const description = opts?.description ?? "Chat slice";
	const files =
		opts?.files ?? [
			{ relpath: "src/chat/index.ts", source: "scan" as const },
			{ relpath: "src/chat/util.ts", source: "user" as const },
		];
	return (url) => {
		if (url.endsWith(LIST(PROJECT_ID))) {
			return jsonResponse([
				{ id: FEATURE_ID, projectId: PROJECT_ID, name: FEATURE_NAME, description },
			]);
		}
		if (url.endsWith(DETAIL(PROJECT_ID, FEATURE_ID))) {
			return jsonResponse({ id: FEATURE_ID, name: FEATURE_NAME, description, files });
		}
		throw new Error(`unexpected url: ${url}`);
	};
}

beforeEach(() => {
	_resetFeatureDetailsCache();
	store.activeProjectId = PROJECT_ID;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	store.activeProjectId = "global";
});

describe("MentionChip feature popover — hover fetch + render", () => {
	test("hovering the chip fires the list + detail fetches", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		expect(chip).not.toBeNull();

		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
			const calls = fetchMock.mock.calls.map((c) => String(c[0]));
			expect(calls.some((u) => u.endsWith(LIST(PROJECT_ID)))).toBe(true);
			expect(calls.some((u) => u.endsWith(DETAIL(PROJECT_ID, FEATURE_ID)))).toBe(true);
		});
	});

	test("popover renders the feature header, description, and file tree", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);

		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover).not.toBeNull();
			expect(popover!.textContent).toContain(`Feature $${FEATURE_NAME}`);
			expect(popover!.textContent).toContain("Chat slice");
			expect(popover!.textContent).toContain("Files (2)");
			expect(popover!.querySelectorAll("[data-feature-tree-file]")).toHaveLength(2);
		});
	});

	test("popover shows 'No description' when feature has no description", async () => {
		stubFetch(defaultHappyPathHandler({ description: "" }));
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover?.textContent).toContain("No description");
		});
	});

	test("popover shows 'No files pinned' when feature has zero files", async () => {
		stubFetch(defaultHappyPathHandler({ files: [] }));
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover?.textContent).toContain("Files (0)");
			expect(popover?.textContent).toContain("No files pinned");
			expect(popover?.querySelectorAll("[data-feature-tree-file]")).toHaveLength(0);
		});
	});

	test("does NOT fetch when activeProjectId is 'global'", async () => {
		store.activeProjectId = "global";
		stubFetch(() => {
			throw new Error("should not fetch");
		});
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		// Popover renders the unavailable fallback (no inflight fetch
		// to wait for). Use waitFor with a small timeout to give
		// Svelte's reactivity time to mount the popover.
		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover).not.toBeNull();
			expect(popover!.textContent).toContain("Feature unavailable");
		});
		const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("popover shows 'Loading feature…' while the fetch is in flight", async () => {
		// Hold the list response so the loading state lasts long enough
		// to assert. We release it at the end so the test doesn't leak.
		let release: ((r: Response) => void) | null = null;
		const pending = new Promise<Response>((r) => { release = r; });
		stubFetch(() => pending);
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover?.textContent).toContain("Loading feature");
		});
		release!(jsonResponse([]));
	});

	test("popover shows 'Feature unavailable.' when fetch resolves to null", async () => {
		stubFetch((url) => {
			if (url.endsWith(LIST(PROJECT_ID))) return jsonResponse([]);
			return jsonResponse({}, 404);
		});
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			const popover = container.querySelector(POPOVER_SEL) as HTMLElement | null;
			expect(popover?.textContent).toContain("Feature unavailable");
		});
	});

	test("popover persists during the close-delay window after chip mouseleave", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
		});

		await fireEvent.mouseLeave(chip);
		// Immediately (well before the 80ms timer expires) the popover is still mounted.
		expect(container.querySelector(POPOVER_SEL)).not.toBeNull();

		// After the close window elapses it unmounts.
		await waitFor(
			() => {
				expect(container.querySelector(POPOVER_SEL)).toBeNull();
			},
			{ timeout: 500 },
		);
	});

	test("popover mouseenter cancels a pending close — moving cursor onto popover keeps it alive", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.mouseEnter(chip);
		await waitFor(() => {
			expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
		});

		await fireEvent.mouseLeave(chip); // schedule close
		const popover = container.querySelector(POPOVER_SEL) as HTMLElement;
		await fireEvent.mouseEnter(popover); // cancel close

		// Wait past the would-be close window; popover MUST still exist.
		await new Promise((r) => setTimeout(r, 200));
		expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
	});
});

describe("MentionChip feature popover — tap-and-hold (mobile)", () => {
	test("500ms touch-hold opens the popover and survives touchend", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.touchStart(chip);
		// Below threshold — popover not yet shown.
		await new Promise((r) => setTimeout(r, 200));
		expect(container.querySelector(POPOVER_SEL)).toBeNull();
		// Past threshold — popover appears and stays after touchend.
		await waitFor(
			() => {
				expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
			},
			{ timeout: 1500 },
		);
		await fireEvent.touchEnd(chip);
		await new Promise((r) => setTimeout(r, 200));
		expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
	});

	test("touchmove before threshold cancels the hold (scrolling, not pressing)", async () => {
		const fetchSpy = vi.fn();
		stubFetch((url) => {
			fetchSpy(url);
			throw new Error("should not fetch — hold was cancelled");
		});
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.touchStart(chip);
		await new Promise((r) => setTimeout(r, 100));
		await fireEvent.touchMove(chip); // user scrolling
		// Wait well past the threshold — nothing should happen.
		await new Promise((r) => setTimeout(r, 700));
		expect(container.querySelector(POPOVER_SEL)).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("touchend before threshold cancels the hold", async () => {
		const fetchSpy = vi.fn();
		stubFetch((url) => {
			fetchSpy(url);
			throw new Error("should not fetch — hold was cancelled");
		});
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.touchStart(chip);
		await new Promise((r) => setTimeout(r, 100));
		await fireEvent.touchEnd(chip);
		await new Promise((r) => setTimeout(r, 700));
		expect(container.querySelector(POPOVER_SEL)).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("document tap outside dismisses a touch-pinned popover", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		await fireEvent.touchStart(chip);
		await waitFor(
			() => {
				expect(container.querySelector(POPOVER_SEL)).not.toBeNull();
			},
			{ timeout: 1500 },
		);
		await fireEvent.touchEnd(chip);

		// Tap somewhere outside the chip wrapper.
		const outside = document.createElement("div");
		document.body.appendChild(outside);
		try {
			await fireEvent.click(outside);
			expect(container.querySelector(POPOVER_SEL)).toBeNull();
		} finally {
			outside.remove();
		}
	});

	test("contextmenu (long-press callout) is suppressed on feature chips", async () => {
		stubFetch(defaultHappyPathHandler());
		const { container } = render(MentionChip, { name: FEATURE_NAME, kind: "feature" });
		const chip = container.querySelector(
			'[data-mention-kind="feature"]',
		) as HTMLElement;
		const event = new Event("contextmenu", { cancelable: true, bubbles: true });
		chip.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});

	test("agent chip (no popover, no tooltip) does NOT preventDefault on contextmenu", async () => {
		const { container } = render(MentionChip, { name: "researcher", kind: "agent" });
		const chip = container.querySelector(
			'[data-mention-kind="agent"]',
		) as HTMLElement;
		const event = new Event("contextmenu", { cancelable: true, bubbles: true });
		chip.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});
});
