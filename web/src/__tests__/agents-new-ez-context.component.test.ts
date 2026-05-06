/**
 * Phase 48 Wave 4 — page-level test for /agents/new.
 *
 * The page is responsible for:
 *   - reading `?prefill=<id>` on mount, hydrating the form, and showing
 *     the AgentPrefillBanner in active or expired state depending on
 *     the draft status
 *   - calling `consumeDraft(id)` on successful submit
 *
 * We render the +page.svelte component directly and exercise the
 * banner through its data-testid hooks.
 */
import "@testing-library/jest-dom/vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// `$app/state` page mock — the page reads `page.url.searchParams` to
// get the `?prefill=<id>` query. We swap the URL per-test by mutating
// the exported object. Hoisted so `vi.mock` callbacks can capture it.
const { pageState, fetchAgentConfigsMock, createAgentConfigMock, getDraftMock, consumeDraftMock } = vi.hoisted(() => ({
	pageState: {
		url: new URL("http://localhost/agents/new"),
		route: { id: "/(app)/agents/new" },
		params: {} as Record<string, string>,
	},
	fetchAgentConfigsMock: vi.fn(),
	createAgentConfigMock: vi.fn(),
	getDraftMock: vi.fn(),
	consumeDraftMock: vi.fn(),
}));

vi.mock("$app/state", () => ({ page: pageState }));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

vi.mock("$lib/api.js", () => ({
	fetchAgentConfigs: (...args: unknown[]) => fetchAgentConfigsMock(...args),
	createAgentConfig: (...args: unknown[]) => createAgentConfigMock(...args),
	// Stub helpers reached via re-export through child components — these
	// are unused by the test path but must resolve.
	createDir: vi.fn(),
	fetchFavicon: vi.fn(),
	fetchProjects: vi.fn().mockResolvedValue([]),
	CURRENT_MODEL_SENTINEL: "current",
}));

vi.mock("$lib/stores.svelte.js", () => ({
	refreshAgentConfigs: vi.fn(),
}));

vi.mock("$lib/ez/api.js", () => ({
	getDraft: (...args: unknown[]) => getDraftMock(...args),
	consumeDraft: (...args: unknown[]) => consumeDraftMock(...args),
}));

// MetaAgentChat / TeamBuilderForm pull in WebSocket + heavy stores. Stub
// them out — the prefill path doesn't depend on them.
vi.mock("$lib/components/MetaAgentChat.svelte", async () => {
	const stub = await import("./stubs/empty-component.js");
	return { default: stub.default };
});
vi.mock("$lib/components/TeamBuilderForm.svelte", async () => {
	const stub = await import("./stubs/empty-component.js");
	return { default: stub.default };
});

import AgentsNewPage from "../routes/(app)/agents/new/+page.svelte";

beforeEach(() => {
	pageState.url = new URL("http://localhost/agents/new");
	fetchAgentConfigsMock.mockReset().mockResolvedValue([
		{ id: "a1", name: "summarizer", prompt: "p", capabilities: [] },
		{ id: "a2", name: "reviewer", prompt: "p", capabilities: [] },
	]);
	createAgentConfigMock.mockReset().mockResolvedValue({ id: "new" });
	getDraftMock.mockReset();
	consumeDraftMock.mockReset().mockResolvedValue({ id: "d", consumedAt: new Date().toISOString() });
});

describe("/agents/new — ?prefill hydration", () => {
	test("active draft: shows the prefill banner in active state", async () => {
		pageState.url = new URL("http://localhost/agents/new?prefill=draft-1");
		getDraftMock.mockResolvedValue({
			id: "draft-1",
			kind: "agent",
			payload: { name: "EmailTriager", prompt: "Triage email" },
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			consumedAt: null,
			consumed: false,
		});
		const { findByTestId } = render(AgentsNewPage);
		const banner = await findByTestId("agent-prefill-banner");
		expect(banner).toHaveAttribute("data-state", "active");
		expect(getDraftMock).toHaveBeenCalledWith("draft-1");
	});

	test("expired draft (consumed): shows the prefill banner in expired state", async () => {
		pageState.url = new URL("http://localhost/agents/new?prefill=draft-2");
		getDraftMock.mockResolvedValue({
			id: "draft-2",
			kind: "agent",
			payload: {},
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			consumedAt: new Date().toISOString(),
			consumed: true,
		});
		const { findByTestId } = render(AgentsNewPage);
		const banner = await findByTestId("agent-prefill-banner");
		expect(banner).toHaveAttribute("data-state", "expired");
	});

	test("expired draft (past expiresAt): shows the expired banner", async () => {
		pageState.url = new URL("http://localhost/agents/new?prefill=draft-3");
		getDraftMock.mockResolvedValue({
			id: "draft-3",
			kind: "agent",
			payload: {},
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			consumedAt: null,
			consumed: false,
		});
		const { findByTestId } = render(AgentsNewPage);
		const banner = await findByTestId("agent-prefill-banner");
		expect(banner).toHaveAttribute("data-state", "expired");
	});

	test("getDraft 404/throw: shows the expired banner (fail closed)", async () => {
		pageState.url = new URL("http://localhost/agents/new?prefill=draft-404");
		getDraftMock.mockRejectedValue(new Error("HTTP 404"));
		const { findByTestId } = render(AgentsNewPage);
		const banner = await findByTestId("agent-prefill-banner");
		expect(banner).toHaveAttribute("data-state", "expired");
	});

	test("dismiss button hides the banner", async () => {
		pageState.url = new URL("http://localhost/agents/new?prefill=draft-1");
		getDraftMock.mockResolvedValue({
			id: "draft-1",
			kind: "agent",
			payload: { name: "Foo" },
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			consumedAt: null,
			consumed: false,
		});
		const { findByTestId, queryByTestId } = render(AgentsNewPage);
		await findByTestId("agent-prefill-banner");
		await fireEvent.click(await findByTestId("agent-prefill-banner-dismiss"));
		await waitFor(() => expect(queryByTestId("agent-prefill-banner")).toBeNull());
	});
});

describe("/agents/new — no-prefill path", () => {
	test("does not call getDraft when no `?prefill` is present", async () => {
		render(AgentsNewPage);
		// Allow microtasks to flush so onMount + $effect both run.
		await new Promise((r) => setTimeout(r, 0));
		expect(getDraftMock).not.toHaveBeenCalled();
	});
});
