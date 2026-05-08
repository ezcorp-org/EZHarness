/**
 * Phase 49.5 — vitest+jsdom axe a11y fallback.
 *
 * The Phase 49 spec § 49.5.1 calls for an axe pass at 375×667 on
 * `/`, `/agents`, `/agents/new`, `/agents/[id]`, `/extensions`, and
 * `/marketplace`. The canonical home for that scan is the Playwright
 * spec at `e2e/accessibility-mobile.spec.ts` — Chromium actually
 * applies media queries, mounts the full app shell, and runs the
 * complete axe ruleset.
 *
 * Why this companion file exists: the v1.3 phase-49 worktree's build
 * is currently broken by a pre-existing `@ezcorp/sdk/runtime`
 * resolution failure (workspace package not materialized — see
 * project memory note "Bun workspaces"). That blocks Playwright's
 * `webServer: bun run build && bun run preview` and means the
 * Playwright spec can't actually execute here.
 *
 * Per orchestrator policy ("Try Playwright first. Fallback to
 * vitest+jsdom if webServer is too heavy"), this test renders each
 * Phase 49 component in jsdom + runs `axe-core` against the rendered
 * DOM. It exercises the new affordances directly (search input,
 * marketplace tag sidebar, extension attach picker modal) without
 * needing the full SvelteKit shell. When the worktree's build is
 * un-broken (out of scope for Phase 49 per the brief), the
 * Playwright spec becomes the canonical run and this file remains
 * as a unit-level regression sentinel.
 *
 * Trade-off: jsdom doesn't compile Tailwind utilities, so
 * color-contrast / visible-focus rules can't be evaluated here —
 * they're disabled. We DO catch missing aria labels, role mistakes,
 * orphaned form controls, untitled buttons, and similar
 * markup-level issues, which is the bulk of axe's value for new
 * Svelte components.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import axe, { type Result as AxeResult } from "axe-core";

// ── axe runner ─────────────────────────────────────────────────────

interface AxeRunOpts {
	/** Disable rules that depend on real CSS / browser layout. */
	disableLayoutRules?: boolean;
}

async function runAxe(
	root: Element,
	opts: AxeRunOpts = {},
): Promise<AxeResult[]> {
	// Disable the rules that need real CSS (jsdom doesn't compile
	// Tailwind so colour / focus visibility can't be evaluated). The
	// Playwright spec catches those.
	const layoutRules: Record<string, { enabled: boolean }> = opts.disableLayoutRules
		? {
				"color-contrast": { enabled: false },
				"target-size": { enabled: false },
				"focus-order-semantics": { enabled: false },
				region: { enabled: false }, // jsdom partial DOM has no <main> wrapper here
			}
		: {};
	// `axe.run(context, options)` overloads — pass the element as the
	// context and the options as the second arg so TS picks the
	// promise-returning overload.
	const results = await axe.run(root, {
		runOnly: {
			type: "tag",
			values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
		},
		rules: layoutRules,
	});
	return results.violations;
}

function describeViolations(v: AxeResult[]): string {
	return v
		.map(
			(r) =>
				`[${r.impact}] ${r.id}: ${r.help}\n    Nodes: ${r.nodes.map((n) => n.html.slice(0, 120)).join("\n           ")}`,
		)
		.join("\n\n");
}

// ── Shared mocks ──────────────────────────────────────────────────

const installedExtensions = [
	{
		id: "ext-1",
		name: "summarizer",
		description: "summarize text",
		manifest: { tools: [{ name: "summarize" }] },
	},
	{
		id: "ext-2",
		name: "translator",
		description: "translate prose",
		manifest: { tools: [{ name: "translate" }] },
	},
];

beforeEach(() => {
	vi.restoreAllMocks();
	const fetchMock = vi.fn(async (url: string) => {
		if (url === "/api/extensions") {
			return new Response(JSON.stringify({ extensions: installedExtensions }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response(JSON.stringify({}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	(globalThis as { fetch: typeof fetch }).fetch =
		fetchMock as unknown as typeof fetch;
});

// ── Phase 49.4 picker ─────────────────────────────────────────────

describe("Phase 49 axe a11y — ExtensionAttachPicker", () => {
	test("modal has no axe violations when open with extensions loaded", async () => {
		const ExtensionAttachPicker = (
			await import("$lib/components/ExtensionAttachPicker.svelte")
		).default;
		const { findAllByTestId, container } = render(ExtensionAttachPicker, {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		});
		// Wait for cards to populate.
		await findAllByTestId("extension-attach-picker-card");
		const violations = await runAxe(container, { disableLayoutRules: true });
		expect(
			violations,
			`ExtensionAttachPicker a11y violations:\n${describeViolations(violations)}`,
		).toEqual([]);
	});

	test("modal has no axe violations in the empty / loading states", async () => {
		// Override fetch to delay so the picker renders the loading state
		// at scan time. This catches a11y bugs that would only surface
		// while the body is still settling.
		const ExtensionAttachPicker = (
			await import("$lib/components/ExtensionAttachPicker.svelte")
		).default;
		const fetchMock = vi.fn(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve(
								new Response(JSON.stringify({ extensions: [] }), {
									status: 200,
									headers: { "Content-Type": "application/json" },
								}),
							),
						50,
					),
				),
		);
		(globalThis as { fetch: typeof fetch }).fetch =
			fetchMock as unknown as typeof fetch;
		const { container, findByTestId } = render(ExtensionAttachPicker, {
			open: true,
			onclose: vi.fn(),
			onsubmit: vi.fn(),
		});
		// Run axe BEFORE the API resolves.
		let violations = await runAxe(container, { disableLayoutRules: true });
		expect(violations).toEqual([]);
		// And again after the empty state resolves.
		await findByTestId("extension-attach-picker-empty");
		violations = await runAxe(container, { disableLayoutRules: true });
		expect(
			violations,
			`Empty-state violations:\n${describeViolations(violations)}`,
		).toEqual([]);
	});
});

// ── Phase 49.3 marketplace sidebar ───────────────────────────────

describe("Phase 49 axe a11y — Marketplace tag sidebar", () => {
	test("tag chips have no axe violations (Phase 49 surface only)", async () => {
		// Pre-existing v1.2 violation on this page: the unlabelled
		// sort <select>. Tracked separately in `accessibility.spec.ts`
		// via `knownRules: ["color-contrast", "select-name"]` — we
		// disable the same rule here so the scan reflects Phase 49
		// deltas, not the pre-existing baseline. If/when the sort
		// dropdown gets a label the rule should be re-enabled.
		const browseMarketplaceMock = vi.fn().mockResolvedValue({
			listings: [],
			featured: [],
		});
		const fetchMarketplaceCategoriesMock = vi.fn().mockResolvedValue({
			categories: [
				{ tag: "research", count: 3 },
				{ tag: "writing", count: 1 },
			],
		});
		vi.doMock("$app/navigation", () => ({ goto: vi.fn() }));
		vi.doMock("$lib/api.js", () => ({
			browseMarketplace: browseMarketplaceMock,
			fetchMarketplaceCategories: fetchMarketplaceCategoriesMock,
			importManifest: vi.fn(),
		}));
		const MarketplacePage = (
			await import("../routes/(app)/marketplace/+page.svelte")
		).default;
		const { findAllByTestId, container } = render(MarketplacePage);
		await findAllByTestId("marketplace-tag-chip");
		// Filter out the pre-existing select-name violation (sort
		// dropdown, not a Phase 49 surface).
		const violations = (
			await runAxe(container, { disableLayoutRules: true })
		).filter((v) => v.id !== "select-name");
		expect(
			violations,
			`Marketplace tag-sidebar a11y violations:\n${describeViolations(violations)}`,
		).toEqual([]);
	});
});

// ── Phase 49.2 agent search input ────────────────────────────────

describe("Phase 49 axe a11y — Agents page search input", () => {
	test("search input + clear button have no axe violations", async () => {
		const fetchAgentsMock = vi.fn().mockResolvedValue([
			{
				id: "a1",
				name: "summarizer",
				description: "summarize",
				source: "config",
				prompt: "p",
				capabilities: [],
				category: null,
				shared: false,
				permission: "write",
			},
		]);
		const fetchAgentConfigsMock = vi.fn().mockResolvedValue([]);
		const rankAgentsMock = vi.fn().mockResolvedValue({
			indices: [0],
			usedWorker: false,
		});
		const pageStub = {
			subscribe: (run: (v: { url: URL; params: Record<string, string> }) => void) => {
				run({ url: new URL("http://localhost/agents"), params: {} });
				return () => {};
			},
		};
		vi.doMock("$app/navigation", () => ({ goto: vi.fn() }));
		vi.doMock("$app/stores", () => ({ page: pageStub }));
		vi.doMock("$lib/api.js", () => ({
			fetchAgents: fetchAgentsMock,
			fetchAgentConfigs: fetchAgentConfigsMock,
			createConversation: vi.fn(),
		}));
		vi.doMock("$lib/stores.svelte.js", () => ({
			store: { activeProjectId: "global" },
		}));
		vi.doMock("$lib/workers/agent-fuzzy-search-bridge.js", () => ({
			rankAgents: rankAgentsMock,
			WORKER_THRESHOLD: 100,
		}));
		const AgentsPage = (await import("../routes/(app)/agents/+page.svelte"))
			.default;
		const { findByTestId, container } = render(AgentsPage);
		const input = (await findByTestId(
			"agent-search-input",
		)) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "summa" } });
		// Wait so the Clear button appears.
		await waitFor(() => {
			expect(input.value).toBe("summa");
		});
		const violations = await runAxe(container, { disableLayoutRules: true });
		expect(
			violations,
			`Agents search a11y violations:\n${describeViolations(violations)}`,
		).toEqual([]);
	});
});
