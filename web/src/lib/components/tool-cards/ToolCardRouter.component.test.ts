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

describe("ToolCardRouter — grade-delta-chart routing (deterministic preprocess)", () => {
	test("cardType='grade-delta-chart' mounts GradeDeltaCard", () => {
		const toolCall: ToolCallState = {
			toolName: "graded-card-scanner__identify_slab",
			status: "complete",
			startedAt: 0,
			cardType: "grade-delta-chart",
			output: JSON.stringify({
				cert: "49392223",
				grader: "PSA",
				identity: {
					subject: "Charizard",
					year: "1999",
					set: "Pokemon Base Set",
					cardNo: "4",
					variety: "",
					grade: "PSA 9",
				},
				grades: { PSA: { "9": 2587.5, "10": 30100 } },
				deltas: [
					{
						company: "PSA",
						steps: [
							{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 },
						],
					},
				],
				sources: {},
			}),
		};

		const { getByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		// `grade-delta-card` is on GradeDeltaCard's root <article>. Its
		// presence proves the router picked GradeDeltaCard — the map entry
		// and the `{#if}` branch travel together (image-gen pin pattern).
		expect(getByTestId("grade-delta-card")).toBeInTheDocument();
		expect(getByTestId("grade-delta-grader")).toHaveTextContent("PSA");
	});
});

describe("ToolCardRouter — ez-preview-consent routing (Secure Preview Phase 2)", () => {
	test("cardType='ez-preview-consent' mounts PreviewConsentCard (rendered once)", () => {
		const toolCall: ToolCallState = {
			id: "tc-consent-1",
			toolName: "preview_detected",
			status: "complete",
			input: {},
			startedAt: 0,
			duration: 0,
			cardType: "ez-preview-consent",
			output: JSON.stringify({ conversationId: "conv-1", port: 5173 }),
		};

		const { getAllByTestId, getByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		// PreviewConsentCard's root data-testid — proof the router picked it.
		// Exactly one (no double-render) — guards the prior streaming-card
		// duplicate-render incident at the router level.
		expect(getAllByTestId("preview-consent-card")).toHaveLength(1);
		expect(getByTestId("preview-consent-expose")).toBeInTheDocument();
	});

	test("malformed payload falls back to DefaultCard (no consent card)", () => {
		const toolCall: ToolCallState = {
			id: "tc-consent-2",
			toolName: "preview_detected",
			status: "complete",
			input: {},
			startedAt: 0,
			duration: 0,
			cardType: "ez-preview-consent",
			output: "not json",
		};
		const { queryByTestId } = render(ToolCardRouter, { toolCall, conversationId: "conv-1" });
		expect(queryByTestId("preview-consent-card")).toBeNull();
	});
});

describe("ToolCardRouter — time-clock routing", () => {
	function timeClockPayload() {
		return {
			cardType: "time-clock",
			label: "Current time",
			formatted: "Monday, May 18, 2026 at 9:40:08 PM UTC",
			timezone: "UTC",
			locale: "en-US",
			iso: "2026-05-18T21:40:08.000Z",
			currentTimeText: "Current time: Monday, May 18, 2026 at 9:40:08 PM UTC",
		};
	}

	test("cardType='time-clock' mounts TimeClockCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-clock-1",
			toolName: "time-teller.tell-time",
			status: "complete",
			input: { timezone: "UTC" },
			startedAt: 0,
			duration: 50,
			cardType: "time-clock",
			output: JSON.stringify(timeClockPayload()),
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
		});

		expect(getByTestId("time-clock-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
	});

	test("completed time-clock JSON renders TimeClockCard even when cardType is missing", () => {
		const toolCall: ToolCallState = {
			id: "tc-clock-fallback-1",
			toolName: "time-teller.tell-time",
			status: "complete",
			input: { timezone: "UTC" },
			startedAt: 0,
			duration: 50,
			output: JSON.stringify(timeClockPayload()),
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
		});

		expect(getByTestId("time-clock-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
	});

	test("ToolCallResult envelope containing time-clock JSON renders TimeClockCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-clock-envelope-1",
			toolName: "time-teller.tell-time",
			status: "complete",
			input: { timezone: "UTC" },
			startedAt: 0,
			duration: 50,
			output: { content: [{ type: "text", text: JSON.stringify(timeClockPayload()) }], isError: false },
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
		});

		expect(getByTestId("time-clock-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
	});

	test("ToolCallResult top-level cardType renders even if inner payload lacks cardType", () => {
		const { cardType: _innerCardType, ...payloadWithoutInnerCardType } = timeClockPayload();
		const toolCall: ToolCallState = {
			id: "tc-clock-envelope-top-level-1",
			toolName: "time-teller.tell-time",
			status: "complete",
			input: { timezone: "UTC" },
			startedAt: 0,
			duration: 50,
			output: {
				content: [{ type: "text", text: JSON.stringify(payloadWithoutInnerCardType) }],
				isError: false,
				cardType: "time-clock",
			},
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
		});

		expect(getByTestId("time-clock-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
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

describe("ToolCardRouter — ez-propose (concierge propose_* deep-link) routing", () => {
	test("propose_create_project result renders EzToolResultCard's 'Open prefilled form' anchor, NOT DefaultCard", () => {
		// The exact wire shape from the real incident: the tool returns
		// `{ draftId, openUrl }` as a JSON string, tagged cardType
		// "ez-propose". Before the fix this fell through to DefaultCard and
		// the form was never surfaced ("no prefilled form was created").
		const toolCall: ToolCallState = {
			id: "tc-propose-1",
			toolName: "propose_create_project",
			status: "complete",
			input: { name: "ezTest", path: "./ezTest" },
			startedAt: 0,
			duration: 300,
			cardType: "ez-propose",
			output: JSON.stringify({
				draftId: "381af91d",
				openUrl: "/new-project?prefill=381af91d",
			}),
		};

		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		expect(getByTestId("ez-tool-result-card")).toBeInTheDocument();
		expect(queryByTestId("tool-card-default")).toBeNull();
		const anchor = getByTestId("ez-card-open");
		expect(anchor.tagName).toBe("A");
		expect(anchor).toHaveAttribute("href", "/new-project?prefill=381af91d");
		// toolName-derived default label for the project propose tool.
		expect(anchor).toHaveTextContent("Open prefilled form");
	});

	test("propose result WITHOUT openUrl falls back to DefaultCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-propose-2",
			toolName: "propose_create_project",
			status: "complete",
			input: { name: "ezTest", path: "./ezTest" },
			startedAt: 0,
			duration: 120,
			cardType: "ez-propose",
			output: JSON.stringify({ draftId: "no-url" }),
		};
		const { getByTestId, queryByTestId } = render(ToolCardRouter, {
			toolCall,
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		expect(getByTestId("tool-card-default")).toBeInTheDocument();
		expect(queryByTestId("ez-tool-result-card")).toBeNull();
	});

	test("propose running call (no output yet) falls back to DefaultCard", () => {
		const toolCall: ToolCallState = {
			id: "tc-propose-3",
			toolName: "propose_create_agent",
			status: "running",
			input: { name: "Summarizer", prompt: "..." },
			startedAt: 0,
			cardType: "ez-propose",
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
