/**
 * Unit tests for grade-delta-logic.ts — payload parsing (three output
 * shapes + lenient degradation), identity title, formatting, grouped
 * bar-chart geometry, and price-table shaping. Pure logic, no DOM.
 */
import { describe, expect, test } from "vitest";
import {
	buildDeltaChart,
	buildPriceTable,
	formatPct,
	formatPrice,
	identityTitle,
	parseGradeDeltaPayload,
	type ChartPlot,
	type GradeDeltaCompany,
	type GradeDeltaIdentity,
} from "./grade-delta-logic";

function identity(overrides: Partial<GradeDeltaIdentity> = {}): GradeDeltaIdentity {
	return {
		subject: "Charizard",
		year: "1999",
		set: "Pokemon Base Set",
		cardNo: "4",
		variety: "Holo",
		grade: "PSA 9",
		...overrides,
	};
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		cert: "49392223",
		grader: "PSA",
		identity: identity(),
		grades: { PSA: { "9": 2587.5, "10": 30100 }, CGC: { "10": 11300 } },
		deltas: [
			{
				company: "PSA",
				steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
			},
		],
		sources: {},
		...overrides,
	};
}

describe("parseGradeDeltaPayload", () => {
	test("parses a raw JSON string (the persisted row shape)", () => {
		const p = parseGradeDeltaPayload(JSON.stringify(record()));
		expect(p).not.toBeNull();
		expect(p!.cert).toBe("49392223");
		expect(p!.grader).toBe("PSA");
		expect(p!.grades.PSA!["10"]).toBe(30100);
		expect(p!.deltas[0]!.steps[0]!.pct).toBe(1063.3);
	});

	test("parses an already-parsed object AND an MCP text envelope", () => {
		expect(parseGradeDeltaPayload(record())).not.toBeNull();
		const envelope = { content: [{ type: "text", text: JSON.stringify(record()) }] };
		expect(parseGradeDeltaPayload(envelope)?.grader).toBe("PSA");
	});

	test("null / malformed string / missing grader / non-object → null", () => {
		expect(parseGradeDeltaPayload(null)).toBeNull();
		expect(parseGradeDeltaPayload(undefined)).toBeNull();
		expect(parseGradeDeltaPayload("{not json")).toBeNull();
		expect(parseGradeDeltaPayload(42)).toBeNull();
		expect(parseGradeDeltaPayload(record({ grader: undefined }))).toBeNull();
		expect(parseGradeDeltaPayload(record({ grader: "" }))).toBeNull();
		expect(parseGradeDeltaPayload(record({ grades: "nope" }))).toBeNull();
		expect(parseGradeDeltaPayload(record({ deltas: "nope" }))).toBeNull();
	});

	test("envelope without a text part / with bad JSON → null", () => {
		expect(parseGradeDeltaPayload({ content: [{ type: "image" }] })).toBeNull();
		expect(parseGradeDeltaPayload({ content: [{ type: "text", text: "{bad" }] })).toBeNull();
	});

	test("non-finite prices coerce to null; malformed steps/companies drop", () => {
		const p = parseGradeDeltaPayload(
			record({
				grades: { PSA: { "9": "not-a-number", "10": 30100 }, BGS: "junk" },
				deltas: [
					{ company: "PSA", steps: [{ from: "9", to: "10", fromPrice: 1, toPrice: 2, pct: 100 }, { from: 9 }] },
					{ company: 42, steps: [] },
					{ company: "CGC", steps: "junk" },
					"garbage",
				],
			}),
		);
		expect(p!.grades).toEqual({ PSA: { "9": null, "10": 30100 } });
		expect(p!.deltas).toEqual([
			{
				company: "PSA",
				steps: [{ from: "9", to: "10", fromPrice: 1, toPrice: 2, pct: 100 }],
			},
		]);
	});

	test("steps with non-finite numerics are dropped", () => {
		const p = parseGradeDeltaPayload(
			record({
				deltas: [
					{
						company: "PSA",
						steps: [
							{ from: "9", to: "10", fromPrice: Number.NaN, toPrice: 2, pct: 1 },
							{ from: "9", to: "10", fromPrice: 1, toPrice: Number.POSITIVE_INFINITY, pct: 1 },
							{ from: "9", to: "10", fromPrice: 1, toPrice: 2, pct: Number.NaN },
						],
					},
				],
			}),
		);
		expect(p!.deltas[0]!.steps).toEqual([]);
	});

	test("missing identity degrades to empty strings; non-string cert → null cert", () => {
		const p = parseGradeDeltaPayload(record({ identity: undefined, cert: 42 }));
		expect(p!.identity).toEqual({
			subject: "",
			year: "",
			set: "",
			cardNo: "",
			variety: "",
			grade: "",
		});
		expect(p!.cert).toBeNull();
	});
});

describe("identityTitle", () => {
	test("joins year + set + subject and appends #cardNo", () => {
		expect(identityTitle(identity())).toBe("1999 Pokemon Base Set Charizard #4");
	});
	test("skips blank parts; no #cardNo when the rest is empty", () => {
		expect(identityTitle(identity({ year: "", set: " " }))).toBe("Charizard #4");
		expect(identityTitle(identity({ subject: "", year: "", set: "", cardNo: "4" }))).toBe("");
		expect(identityTitle(identity({ cardNo: "" }))).toBe("1999 Pokemon Base Set Charizard");
	});
});

describe("formatPct / formatPrice", () => {
	test("formatPct signs both directions (typographic minus)", () => {
		expect(formatPct(1063.3)).toBe("+1063.3%");
		expect(formatPct(-25)).toBe("−25%");
		expect(formatPct(0)).toBe("+0%");
	});
	test("formatPrice renders dollars or N/A (never $0 for missing)", () => {
		expect(formatPrice(2587.5)).toBe("$2,587.50");
		expect(formatPrice(null)).toBe("N/A");
		expect(formatPrice(undefined)).toBe("N/A");
		expect(formatPrice(Number.NaN)).toBe("N/A");
	});
});

// ── chart geometry ──────────────────────────────────────────────────

const PLOT: ChartPlot = {
	width: 480,
	height: 190,
	padTop: 26,
	padBottom: 34,
	padX: 12,
	groupGap: 28,
	barGap: 8,
};

const DELTAS: GradeDeltaCompany[] = [
	{
		company: "PSA",
		steps: [
			{ from: "8", to: "9", fromPrice: 1201.99, toPrice: 2587.5, pct: 115.3 },
			{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 },
		],
	},
	{
		company: "BGS",
		steps: [{ from: "9.5", to: "10", fromPrice: 3875, toPrice: 46000, pct: -12.4 }],
	},
];

describe("buildDeltaChart", () => {
	test("one bar per step, grouped per company, tallest bar = max |pct|", () => {
		const chart = buildDeltaChart(DELTAS, PLOT);
		expect(chart).not.toBeNull();
		expect(chart!.bars).toHaveLength(3);
		expect(chart!.groups.map((g) => g.company)).toEqual(["PSA", "BGS"]);
		expect(chart!.maxAbsPct).toBe(1063.3);
		const innerH = PLOT.height - PLOT.padTop - PLOT.padBottom;
		const tallest = chart!.bars[1]!;
		expect(tallest.h).toBeCloseTo(innerH);
		expect(tallest.y).toBeCloseTo(PLOT.padTop);
		// Labels carry the spec-mandated "PSA 9→10 +6203%" style parts.
		expect(tallest.stepLabel).toBe("PSA 9→10");
		expect(tallest.pctLabel).toBe("+1063.3%");
	});

	test("negative steps are flagged (price drop renders red)", () => {
		const chart = buildDeltaChart(DELTAS, PLOT);
		expect(chart!.bars[2]!.negative).toBe(true);
		expect(chart!.bars[0]!.negative).toBe(false);
	});

	test("bars never fall below the 2px visibility floor", () => {
		const chart = buildDeltaChart(
			[
				{
					company: "PSA",
					steps: [
						{ from: "1", to: "2", fromPrice: 100, toPrice: 100.01, pct: 0 },
						{ from: "2", to: "3", fromPrice: 100, toPrice: 10000, pct: 9900 },
					],
				},
			],
			PLOT,
		);
		expect(chart!.bars[0]!.h).toBe(2);
	});

	test("all-zero pcts still render floor-height bars (no division blowup)", () => {
		const chart = buildDeltaChart(
			[{ company: "PSA", steps: [{ from: "1", to: "2", fromPrice: 1, toPrice: 1, pct: 0 }] }],
			PLOT,
		);
		expect(chart!.bars[0]!.h).toBe(2);
	});

	test("groups are laid out left-to-right without overlap", () => {
		const chart = buildDeltaChart(DELTAS, PLOT);
		const [a, b, c] = chart!.bars;
		expect(a!.x).toBeLessThan(b!.x);
		expect(b!.x + b!.w).toBeLessThan(c!.x);
		expect(chart!.groups[0]!.xCenter).toBeLessThan(chart!.groups[1]!.xCenter);
	});

	test("companies with zero steps are skipped; nothing at all → null", () => {
		expect(buildDeltaChart([{ company: "CGC", steps: [] }], PLOT)).toBeNull();
		expect(buildDeltaChart([], PLOT)).toBeNull();
	});
});

describe("buildPriceTable", () => {
	test("union of grades (numeric ascending) × companies (sorted); missing cells null", () => {
		const table = buildPriceTable({
			PSA: { "9": 2587.5, "10": 30100 },
			BGS: { "9.5": 3875 },
			CGC: { "10": null },
		});
		expect(table!.companies).toEqual(["BGS", "CGC", "PSA"]);
		expect(table!.rows.map((r) => r.grade)).toEqual(["9", "9.5", "10"]);
		// Row "9": BGS absent → null, CGC absent → null, PSA priced.
		expect(table!.rows[0]!.prices).toEqual([null, null, 2587.5]);
		// Row "10": CGC explicit null stays null.
		expect(table!.rows[2]!.prices).toEqual([null, null, 30100]);
	});

	test("single-priced companies ARE listed (chart omits them, table never does)", () => {
		const table = buildPriceTable({ SGC: { "10": 8494.97 } });
		expect(table!.companies).toEqual(["SGC"]);
		expect(table!.rows).toEqual([{ grade: "10", prices: [8494.97] }]);
	});

	test("empty / grade-less maps → null (no empty table shell)", () => {
		expect(buildPriceTable({})).toBeNull();
		expect(buildPriceTable({ PSA: {} })).toBeNull();
	});
});
