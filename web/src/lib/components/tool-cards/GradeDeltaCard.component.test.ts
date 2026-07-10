/**
 * DOM tests for GradeDeltaCard.svelte.
 *
 * Covers the identify_slab card contract:
 *   - Header: grader badge, cert number, identity title (+ grade suffix).
 *   - Grouped bar chart: one bar per adjacent-grade step, one group
 *     label per company, negative steps flagged red.
 *   - Null-safety: companies with < 2 priced grades are absent from the
 *     chart (backend omits their deltas) but present in the price table;
 *     missing prices render "N/A".
 *   - Unknown grader → "Slab not identified" + no-chart note.
 *   - Malformed payload → inline error (no blank card).
 */
import { render, cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import GradeDeltaCard from "./GradeDeltaCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

afterEach(() => cleanup());

function makeToolCall(payload: unknown): ToolCallState {
	return {
		toolName: "graded-card-scanner__identify_slab",
		status: "complete",
		output: typeof payload === "string" ? payload : JSON.stringify(payload),
		startedAt: 0,
		cardType: "grade-delta-chart",
	};
}

const FULL_PAYLOAD = {
	cert: "49392223",
	grader: "PSA",
	identity: {
		subject: "Charizard",
		year: "1999",
		set: "Pokemon Base Set",
		cardNo: "4",
		variety: "Holo",
		grade: "PSA 9",
	},
	grades: {
		PSA: { "9": 2587.5, "10": 30100 },
		BGS: { "9.5": 3875, "10": 46000 },
		SGC: { "10": 8494.97 },
	},
	deltas: [
		{
			company: "PSA",
			steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
		},
		{
			company: "BGS",
			steps: [{ from: "9.5", to: "10", fromPrice: 3875, toPrice: 46000, pct: -12.4 }],
		},
	],
	sources: {},
};

describe("GradeDeltaCard — full payload", () => {
	test("renders the header (badge + cert + identity title with grade)", () => {
		const { getByTestId } = render(GradeDeltaCard, { toolCall: makeToolCall(FULL_PAYLOAD) });
		expect(getByTestId("grade-delta-grader")).toHaveTextContent("PSA");
		expect(getByTestId("grade-delta-cert")).toHaveTextContent("#49392223");
		expect(getByTestId("grade-delta-title")).toHaveTextContent(
			"1999 Pokemon Base Set Charizard #4",
		);
		expect(getByTestId("grade-delta-title")).toHaveTextContent("PSA 9");
	});

	test("renders one bar per step with 'PSA 9→10 +1063.3%' style labels", () => {
		const { getByTestId, getAllByTestId, container } = render(GradeDeltaCard, {
			toolCall: makeToolCall(FULL_PAYLOAD),
		});
		expect(getByTestId("grade-delta-chart")).toBeInTheDocument();
		const bars = getAllByTestId("grade-delta-bar");
		expect(bars).toHaveLength(2);
		// Accessible per-bar tooltip carries the full label.
		expect(bars[0]!.querySelector("title")?.textContent).toBe("PSA 9→10 +1063.3%");
		expect(bars[1]!.querySelector("title")?.textContent).toBe("BGS 9.5→10 −12.4%");
		// Negative step renders with the down class.
		expect(bars[0]!.classList.contains("dn")).toBe(false);
		expect(bars[1]!.classList.contains("dn")).toBe(true);
		// Group labels: one per company WITH steps (SGC omitted — 1 grade).
		const groups = getAllByTestId("grade-delta-group");
		expect(groups.map((g) => g.textContent?.trim())).toEqual(["PSA", "BGS"]);
		// Pct labels are drawn as SVG text too.
		expect(container.textContent).toContain("+1063.3%");
	});

	test("price table lists EVERY company (chart-omitted SGC included) with N/A for gaps", () => {
		const { getByTestId } = render(GradeDeltaCard, { toolCall: makeToolCall(FULL_PAYLOAD) });
		const table = getByTestId("grade-delta-table");
		// Columns sorted: BGS, PSA, SGC.
		const headers = Array.from(table.querySelectorAll("th")).map((th) => th.textContent?.trim());
		expect(headers).toEqual(["Grade", "BGS", "PSA", "SGC"]);
		const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
			Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim()),
		);
		expect(rows).toEqual([
			["9", "N/A", "$2,587.50", "N/A"],
			["9.5", "$3,875.00", "N/A", "N/A"],
			["10", "$46,000.00", "$30,100.00", "$8,494.97"],
		]);
	});
});

describe("GradeDeltaCard — degraded payloads", () => {
	test("unknown grader: badge + honest placeholder title + no chart, no table", () => {
		const { getByTestId, queryByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				cert: null,
				grader: "unknown",
				identity: { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" },
				grades: {},
				deltas: [],
				sources: {},
			}),
		});
		expect(getByTestId("grade-delta-grader")).toHaveTextContent("unknown");
		expect(getByTestId("grade-delta-title")).toHaveTextContent("Slab not identified");
		expect(queryByTestId("grade-delta-cert")).toBeNull();
		expect(queryByTestId("grade-delta-chart")).toBeNull();
		expect(getByTestId("grade-delta-no-chart")).toBeInTheDocument();
		expect(queryByTestId("grade-delta-table")).toBeNull();
	});

	test("known grader with no identity (decode-only BGS) shows 'Identity unavailable'", () => {
		const { getByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				cert: "0012345678",
				grader: "BGS",
				identity: { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" },
				grades: {},
				deltas: [],
				sources: {},
			}),
		});
		expect(getByTestId("grade-delta-title")).toHaveTextContent("Identity unavailable");
		expect(getByTestId("grade-delta-cert")).toHaveTextContent("#0012345678");
	});

	test("table without chart: single-priced companies keep their table", () => {
		const { getByTestId, queryByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				cert: "4189145001",
				grader: "CGC",
				identity: { subject: "Charizard", year: "", set: "", cardNo: "", variety: "", grade: "9.5" },
				grades: { CGC: { "10": 11300 } },
				deltas: [],
				sources: {},
			}),
		});
		expect(queryByTestId("grade-delta-chart")).toBeNull();
		expect(getByTestId("grade-delta-no-chart")).toBeInTheDocument();
		expect(getByTestId("grade-delta-table")).toHaveTextContent("$11,300.00");
	});

	test("malformed payload → inline error, no card shell", () => {
		const { getByTestId, queryByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall("{broken json"),
		});
		expect(getByTestId("grade-delta-missing")).toHaveTextContent("Cannot render slab card");
		expect(queryByTestId("grade-delta-card")).toBeNull();
	});

	test("psa-api:no-token identity stamp → actionable hint in the identity-unavailable state", () => {
		const { getByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				cert: "49392223",
				grader: "PSA",
				identity: { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" },
				grades: {},
				deltas: [],
				sources: {
					decode: { source: "zxing", fetchedAt: "t" },
					identity: { source: "psa-api:no-token", fetchedAt: "t" },
					price: { source: "not-searched", fetchedAt: "t" },
				},
			}),
		});
		expect(getByTestId("grade-delta-title")).toHaveTextContent("Identity unavailable");
		const hint = getByTestId("grade-delta-hint");
		// Actionable: tells the user HOW to fix it (ask the assistant to
		// save a free PSA token via set_psa_token).
		expect(hint).toHaveTextContent("set_psa_token");
		expect(hint).toHaveTextContent("api.psacard.com");
	});

	test("ok identity data → no hint element", () => {
		const { queryByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				...FULL_PAYLOAD,
				sources: {
					decode: { source: "zxing", fetchedAt: "t" },
					identity: { source: "psa-api", fetchedAt: "t" },
					price: { source: "pricecharting", fetchedAt: "t" },
				},
			}),
		});
		expect(queryByTestId("grade-delta-hint")).toBeNull();
	});

	test("unknown identity stamp → no hint (never speculate)", () => {
		const { queryByTestId } = render(GradeDeltaCard, {
			toolCall: makeToolCall({
				cert: "0012345678",
				grader: "BGS",
				identity: { subject: "", year: "", set: "", cardNo: "", variety: "", grade: "" },
				grades: {},
				deltas: [],
				sources: {
					decode: { source: "zxing", fetchedAt: "t" },
					identity: { source: "decode-only", fetchedAt: "t" },
					price: { source: "not-searched", fetchedAt: "t" },
				},
			}),
		});
		expect(queryByTestId("grade-delta-hint")).toBeNull();
	});
});
