/**
 * Mount-level test for ToolCardRouter.svelte.
 *
 * The sibling bun-test suite (`src/__tests__/tool-card-router.test.ts`)
 * covers `getCardComponentName` — the pure string-map that drives the
 * `{#if cardName === '…'}` branches inside the router. That alone is
 * NOT proof that the router actually wires `cardType: "image-gen-grid"`
 * through to `<ImageGenCard>`: the map could be right and the router
 * branch could still be missing, or vice versa.
 *
 * This test pins the contract that "cardType: 'image-gen-grid' renders
 * an ImageGenCard-rooted element" so the mapping and the branch travel
 * together. It uses ImageGenCard's `data-testid="tool-card-image-gen"`
 * (set on the root <div> of that component) as the proof-of-render.
 *
 * NOTE: we don't try to assert against every cardType here — this is the
 * regression-pin for the new image-gen routing only. Other cards have
 * their own component tests; the cardType map is exhaustively unit-tested
 * in the bun-test sibling.
 */

import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import ToolCardRouter from "./ToolCardRouter.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

beforeAll(() => {
	// jsdom lacks the Web Animations API; svelte/transition's `slide`
	// (used by the CollapsibleCard wrapper on expand) calls Element.animate.
	if (typeof Element.prototype.animate !== "function") {
		(Element.prototype as unknown as { animate: () => unknown }).animate = () => ({
			cancel: () => {},
			finished: Promise.resolve(),
			finish: () => {},
			pause: () => {},
			play: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
		});
	}
});

beforeEach(() => {
	// ImageGenCard's eager-fetch effect runs whenever the truncated
	// output contains an image marker. Stub fetch to a benign 200 so it
	// doesn't blow up jsdom.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
	);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ToolCardRouter — image-gen-grid routing", () => {
	test("cardType='image-gen-grid' mounts ImageGenCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-route-1",
			toolName: "openai-image-gen-2.generate",
			status: "complete",
			input: { prompt: "cat", n: 2 },
			startedAt: 0,
			duration: 500,
			cardType: "image-gen-grid",
			output:
				"Generated 2 images with OpenAI.\n\n" +
				"![cat 1](/api/ext-files/openai-image-gen-2/generated/img-1.png)\n" +
				"![cat 2](/api/ext-files/openai-image-gen-2/generated/img-2.png)",
		};

		const { getByTestId, getAllByRole } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		// `tool-card-image-gen` is on ImageGenCard's root <div>. Its
		// presence is the proof that the router picked ImageGenCard
		// (DefaultCard / other branches don't set this id).
		expect(getByTestId("tool-card-image-gen")).toBeInTheDocument();
		// And the grid actually rendered — the two image markers in the
		// output round-trip through the regex and back into DOM <img>s.
		expect(getAllByRole("img")).toHaveLength(2);
	});

});

describe("ToolCardRouter — weather fallback routing", () => {
	test("completed weather-shaped JSON renders WeatherCard even when cardType is missing", () => {
		const toolCall: ToolCallState = {
			id: "tc-weather-fallback-1",
			toolName: "weather-ui__weather-now",
			status: "complete",
			input: { location: "Atlanta" },
			startedAt: 0,
			duration: 200,
			output: JSON.stringify({
				location: { name: "Atlanta", admin1: "Georgia", country: "United States", timezone: "America/New_York" },
				units: { temperature: "°F", windSpeed: "mph" },
				current: { temperature: 70, feelsLike: 70, windSpeed: 6, humidity: 78, condition: "Sunny", emoji: "☀️", isDay: true },
				daily: [{ date: "2026-06-01", dayLabel: "Today", condition: "Sunny", emoji: "☀️", tempMax: 80, tempMin: 65, precipitationChance: 0 }],
				hourly: [{ time: "2026-06-01T12:00", label: "Now", temperature: 70, condition: "Sunny", emoji: "☀️" }],
			}),
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
		});

		expect(getByTestId("weather-card-host")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
	});
});

describe("ToolCardRouter — ez-install (install_draft deep-link) routing", () => {
	test("install_draft result with openUrl renders EzToolResultCard's 'Open extension' anchor, NOT DefaultCard's <pre>", () => {
		// Mirrors the live wire: extension tool result reaches
		// `ToolCallState.output` as a JSON STRING (the store's
		// `extractToolOutput` already unwrapped the MCP content envelope),
		// and the bundled extension-author manifest tags `install_draft`
		// with `cardType: "ez-install"`.
		const toolCall: ToolCallState = {
			id: "tc-install-1",
			toolName: "extension-author.install_draft",
			status: "complete",
			input: { draftId: "draft-1" },
			startedAt: 0,
			duration: 1200,
			cardType: "ez-install",
			output: JSON.stringify({
				ok: true,
				extensionId: "ext-42",
				name: "weather",
				openUrl: "/extensions/weather",
			}),
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		// EzToolResultCard mounted (DefaultCard NOT).
		expect(getByTestId("ez-tool-result-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
		// The deep-link is a real, same-origin, relative <a href> (D2 safe
		// binding) labelled "Open extension" (D1 generalized label).
		const anchor = getByTestId("ez-card-open");
		expect(anchor.tagName).toBe("A");
		expect(anchor).toHaveAttribute("href", "/extensions/weather");
		expect(anchor).toHaveTextContent("Open extension");
	});

	test("ez-install result WITHOUT openUrl falls back to DefaultCard (today's behavior preserved)", () => {
		// The host omits `openUrl` when the manifest name failed the
		// NAME_REGEX re-check. The card has no actionable affordance then,
		// so the router must degrade to DefaultCard (raw JSON) — never an
		// empty/broken EzToolResultCard.
		const toolCall: ToolCallState = {
			id: "tc-install-2",
			toolName: "extension-author.install_draft",
			status: "complete",
			input: { draftId: "draft-2" },
			startedAt: 0,
			duration: 800,
			cardType: "ez-install",
			output: JSON.stringify({ ok: true, extensionId: "ext-43", name: "weather" }),
		};
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		expect(getByTestId("tool-card-default")).toBeInTheDocument();
		expect(queryByTestId("ez-tool-result-card")).toBeNull();
	});

	test("ez-install running call (no output yet) falls back to DefaultCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-install-3",
			toolName: "extension-author.install_draft",
			status: "running",
			input: { draftId: "draft-3" },
			startedAt: 0,
			cardType: "ez-install",
		};
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		expect(getByTestId("tool-card-default")).toBeInTheDocument();
		expect(queryByTestId("ez-tool-result-card")).toBeNull();
	});
});

describe("ToolCardRouter — image-gen-grid permission gate", () => {
	test("permissionPending overrides cardType and renders PermissionGate (not ImageGenCard)", () => {
		// Mirrors the bun-test sibling's "image-gen-grid still respects
		// permissionPending gate" — `getCardComponentName` returns
		// 'PermissionGate' regardless of cardType when permissionPending
		// is true. Pin it at the router level too so a future router
		// refactor can't accidentally let an unapproved image-gen call
		// auto-mount and fetch.
		const toolCall: ToolCallState = {
			id: "tc-route-2",
			toolName: "openai-image-gen-2.generate",
			status: "running",
			input: { prompt: "cat", n: 1 },
			startedAt: 0,
			cardType: "image-gen-grid",
			permissionPending: true,
		};
		const { queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		// ImageGenCard NOT mounted.
		expect(queryByTestId("tool-card-image-gen")).toBeNull();
	});
});

describe("ToolCardRouter — dev-command collapse wrapping", () => {
	function terminalCall(): ToolCallState {
		return {
			id: "tc-term-1",
			toolName: "Bash",
			status: "complete",
			input: { command: "grep -rn foo src" },
			output: "src/a.ts:1:foo",
			startedAt: 0,
			duration: 300,
			cardType: "terminal",
		};
	}

	test("mode='inline' wraps TerminalCard in a collapsed CollapsibleCard", async () => {
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall: terminalCall(),
			conversationId: "conv-1",
		});

		// The collapsible shell is present…
		expect(getByTestId("collapsible-card")).toBeInTheDocument();
		// …and the terminal body is hidden until the user expands it.
		expect(queryByTestId("tool-card-terminal")).toBeNull();

		// cmd-matches-cmd-used at the router→shell boundary: the full
		// command is shown verbatim even while collapsed.
		expect(getByTestId("collapsible-card-command").textContent).toBe("grep -rn foo src");

		await fireEvent.click(getByTestId("collapsible-card-toggle"));
		expect(getByTestId("tool-card-terminal")).toBeInTheDocument();
		// …and it is still exactly the command after expanding.
		expect(getByTestId("collapsible-card-command").textContent).toBe("grep -rn foo src");
	});

	test("mode='dock' renders the TerminalCard bare (no collapse wrapper)", () => {
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall: terminalCall(),
			conversationId: "conv-1",
			mode: "dock",
		});

		// No collapsible shell in the dock; the card renders full-size.
		expect(queryByTestId("collapsible-card")).toBeNull();
		expect(getByTestId("tool-card-terminal")).toBeInTheDocument();
	});

	test("mode='inline' also wraps the grep SearchResultsCard", async () => {
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall: {
				id: "tc-grep-1",
				toolName: "grep",
				status: "complete",
				input: { pattern: "foo" },
				output: "src/a.ts:1:foo bar",
				startedAt: 0,
				duration: 120,
				cardType: "search-results",
			},
			conversationId: "conv-1",
		});

		expect(getByTestId("collapsible-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-search-results")).toBeNull();

		await fireEvent.click(getByTestId("collapsible-card-toggle"));
		expect(getByTestId("tool-card-search-results")).toBeInTheDocument();
	});
});
