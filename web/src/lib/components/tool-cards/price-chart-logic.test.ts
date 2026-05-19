import { describe, expect, test } from "bun:test";
import {
	buildPlot,
	computeChange,
	formatDate,
	formatPrice,
	formatSignedDelta,
	nearestPoint,
	parsePayload,
	sliceRange,
	type ChartPoint,
} from "./price-chart-logic";

function makeSeries(count: number, baseT = Date.parse("2026-01-01T00:00:00Z")): ChartPoint[] {
	const day = 86_400_000;
	return Array.from({ length: count }, (_, i) => ({ t: baseT + i * day, v: 100 + i }));
}

describe("parsePayload", () => {
	test("parses a JSON string", () => {
		const payload = parsePayload(
			JSON.stringify({
				kind: "stock", symbol: "AAPL", name: "Apple Inc.", logoUrl: "https://l/a.png",
				currency: "USD", lastPrice: 100, prevClose: 99,
				points: [{ t: 1, v: 99 }, { t: 2, v: 100 }],
			}),
		);
		expect(payload).not.toBeNull();
		expect(payload!.symbol).toBe("AAPL");
		expect(payload!.kind).toBe("stock");
		expect(payload!.points.length).toBe(2);
	});

	test("parses an MCP envelope", () => {
		const envelope = {
			content: [{
				type: "text",
				text: JSON.stringify({
					kind: "crypto", symbol: "BTC", name: "Bitcoin", logoUrl: "https://x/y.png",
					currency: "USD", lastPrice: 30000, prevClose: 28000,
					points: [{ t: 1, v: 30000 }],
				}),
			}],
		};
		const payload = parsePayload(envelope);
		expect(payload).not.toBeNull();
		expect(payload!.kind).toBe("crypto");
		expect(payload!.symbol).toBe("BTC");
	});

	test("returns null for empty/invalid input", () => {
		expect(parsePayload(null)).toBeNull();
		expect(parsePayload("not json")).toBeNull();
		expect(parsePayload({})).toBeNull();
		expect(parsePayload({ points: [] })).toBeNull();
		expect(parsePayload({ symbol: "X", points: [] })).toBeNull();
	});

	test("drops malformed points", () => {
		const payload = parsePayload({
			kind: "stock", symbol: "X", name: "X", logoUrl: "", currency: "USD",
			lastPrice: 10, prevClose: 9,
			points: [{ t: 1, v: 2 }, { t: "bad", v: 2 }, { t: 3, v: NaN }, { t: 4, v: 5 }],
		});
		expect(payload).not.toBeNull();
		expect(payload!.points.length).toBe(2);
	});

	test("kind defaults to stock for unrecognized values", () => {
		const payload = parsePayload({
			kind: "wat", symbol: "Y", name: "Y", logoUrl: "", currency: "USD",
			lastPrice: 1, prevClose: 1, points: [{ t: 1, v: 1 }],
		});
		expect(payload!.kind).toBe("stock");
	});
});

describe("sliceRange", () => {
	test("returns trailing 7 days for 1w on 365-day series", () => {
		const slice = sliceRange(makeSeries(365), "1w");
		// 7-day cutoff anchored on the last point — inclusive (>= cutoff).
		expect(slice.length).toBe(8);
	});

	test("returns ~30 days for 1m", () => {
		const slice = sliceRange(makeSeries(365), "1m");
		expect(slice.length).toBe(31);
	});

	test("returns full series for 1y when input ≤ 1y", () => {
		const slice = sliceRange(makeSeries(200), "1y");
		expect(slice.length).toBe(200);
	});

	test("empty input → empty output", () => {
		expect(sliceRange([], "1y")).toEqual([]);
	});
});

describe("buildPlot", () => {
	const geom = { width: 100, height: 100, padTop: 10, padRight: 10, padBottom: 10, padLeft: 10 };

	test("maps first/last points to the inner edges", () => {
		const result = buildPlot(makeSeries(11), geom);
		expect(result.pixelPoints[0]!.x).toBe(10);
		expect(result.pixelPoints[10]!.x).toBe(90);
	});

	test("min and max values map to the inner bottom and top respectively", () => {
		const result = buildPlot(makeSeries(11), geom);
		// First point is min (v=100) → bottom (y=90); last is max (v=110) → top (y=10).
		expect(result.pixelPoints[0]!.y).toBeCloseTo(90, 1);
		expect(result.pixelPoints[10]!.y).toBeCloseTo(10, 1);
	});

	test("linePath starts with M and uses L for subsequent points", () => {
		const result = buildPlot(makeSeries(3), geom);
		expect(result.linePath.startsWith("M")).toBe(true);
		expect(result.linePath).toContain(" L");
	});

	test("areaPath closes back to baseline", () => {
		const result = buildPlot(makeSeries(3), geom);
		expect(result.areaPath.endsWith("Z")).toBe(true);
	});

	test("single point doesn't crash (vSpan/tSpan fallbacks)", () => {
		const result = buildPlot([{ t: 1, v: 5 }], geom);
		expect(result.pixelPoints.length).toBe(1);
		expect(Number.isFinite(result.pixelPoints[0]!.x)).toBe(true);
		expect(Number.isFinite(result.pixelPoints[0]!.y)).toBe(true);
	});

	test("flat series (all same value) doesn't divide by zero", () => {
		const flat: ChartPoint[] = Array.from({ length: 5 }, (_, i) => ({ t: i, v: 42 }));
		const result = buildPlot(flat, geom);
		for (const p of result.pixelPoints) {
			expect(Number.isFinite(p.y)).toBe(true);
		}
	});
});

describe("nearestPoint", () => {
	test("returns the closest by x", () => {
		const pts = [
			{ x: 0, y: 0, t: 1, v: 1 },
			{ x: 50, y: 0, t: 2, v: 2 },
			{ x: 100, y: 0, t: 3, v: 3 },
		];
		expect(nearestPoint(pts, 0)?.t).toBe(1);
		expect(nearestPoint(pts, 60)?.t).toBe(2);
		expect(nearestPoint(pts, 90)?.t).toBe(3);
	});

	test("empty array → null", () => {
		expect(nearestPoint([], 0)).toBeNull();
	});
});

describe("formatting helpers", () => {
	test("formatDate returns ISO YYYY-MM-DD", () => {
		expect(formatDate(Date.parse("2026-05-14T12:34:56Z"))).toBe("2026-05-14");
	});

	test("formatPrice grouped + 2 decimals", () => {
		expect(formatPrice("USD", 1234.5)).toBe("USD 1,234.50");
		expect(formatPrice("USD", 0)).toBe("USD 0.00");
	});

	test("formatSignedDelta prepends sign for positive, leaves negative as-is", () => {
		expect(formatSignedDelta(1.234)).toBe("+1.23");
		expect(formatSignedDelta(-2.5)).toBe("-2.50");
		expect(formatSignedDelta(0)).toBe("+0.00");
	});
});

describe("computeChange", () => {
	test("up", () => {
		const c = computeChange(110, 100);
		expect(c.abs).toBe(10);
		expect(c.pct).toBe(10);
		expect(c.isUp).toBe(true);
	});
	test("down", () => {
		const c = computeChange(90, 100);
		expect(c.abs).toBe(-10);
		expect(c.pct).toBe(-10);
		expect(c.isUp).toBe(false);
	});
	test("prevClose=0 → pct=0 (no div-by-zero)", () => {
		const c = computeChange(10, 0);
		expect(c.pct).toBe(0);
		expect(c.abs).toBe(10);
	});
});

describe("change derivation across range switches", () => {
	// Pins the card's behaviour: the headline % change is the slice's
	// last-vs-first value (so 1W shows the week's move, 1Y shows the
	// year's move), NOT the static prevClose carried in the payload.
	test("switching range changes the headline pct", () => {
		// Construct a 365-day series where the last 7 days are flat at 100
		// but the year-over-year is +50%.
		const series: ChartPoint[] = [];
		const baseT = Date.parse("2026-01-01T00:00:00Z");
		const day = 86_400_000;
		for (let i = 0; i < 358; i++) series.push({ t: baseT + i * day, v: 66.67 + (i / 357) * 33.33 });
		for (let i = 358; i < 365; i++) series.push({ t: baseT + i * day, v: 100 });

		const week = sliceRange(series, "1w");
		const year = sliceRange(series, "1y");

		const weekChange = computeChange(week[week.length - 1]!.v, week[0]!.v);
		const yearChange = computeChange(year[year.length - 1]!.v, year[0]!.v);

		// 1W slice is flat — change ~0.
		expect(Math.abs(weekChange.pct)).toBeLessThan(0.5);
		// 1Y slice spans the +50% run-up.
		expect(yearChange.pct).toBeGreaterThan(40);
	});
});
