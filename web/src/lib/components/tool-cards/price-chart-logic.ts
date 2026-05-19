/**
 * Pure logic for PriceChartCard — extracted so unit tests can exercise
 * payload parsing, range filtering, scaling, and SVG path generation
 * without rendering Svelte.
 */

export interface ChartPoint {
	/** Epoch ms. */
	t: number;
	/** Price in `currency`. */
	v: number;
}

export type AssetKind = "stock" | "crypto";

export interface ChartPayload {
	kind: AssetKind;
	symbol: string;
	name: string;
	logoUrl: string;
	currency: string;
	lastPrice: number;
	prevClose: number;
	points: ChartPoint[];
}

export type Range = "1w" | "1m" | "3m" | "1y";

export const RANGES: ReadonlyArray<Range> = ["1w", "1m", "3m", "1y"] as const;

const DAY_MS = 86_400_000;
const RANGE_MS: Record<Range, number> = {
	"1w": 7 * DAY_MS,
	"1m": 30 * DAY_MS,
	"3m": 90 * DAY_MS,
	"1y": 365 * DAY_MS,
};

/**
 * Extract a ChartPayload from a tool-call `output` value. Accepts the
 * three shapes the chat store may deliver (live string, MCP envelope,
 * already-parsed object). Returns `null` if the shape is missing
 * mandatory fields — caller renders a fallback.
 */
export function parsePayload(out: unknown): ChartPayload | null {
	const obj = extractObject(out);
	if (!obj) return null;
	if (!Array.isArray(obj.points)) return null;
	const points = obj.points.filter(
		(p): p is ChartPoint =>
			!!p && typeof p === "object" &&
			typeof (p as ChartPoint).t === "number" &&
			typeof (p as ChartPoint).v === "number" &&
			Number.isFinite((p as ChartPoint).t) &&
			Number.isFinite((p as ChartPoint).v),
	);
	if (points.length === 0) return null;
	const symbol = stringOr(obj.symbol, "");
	if (!symbol) return null;
	return {
		kind: obj.kind === "crypto" ? "crypto" : "stock",
		symbol,
		name: stringOr(obj.name, symbol),
		logoUrl: stringOr(obj.logoUrl, ""),
		currency: stringOr(obj.currency, "USD"),
		lastPrice: numberOr(obj.lastPrice, points[points.length - 1]!.v),
		prevClose: numberOr(obj.prevClose, points[0]!.v),
		points,
	};
}

function extractObject(out: unknown): Record<string, unknown> | null {
	if (out == null) return null;
	if (typeof out === "string") {
		try {
			return JSON.parse(out) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	if (typeof out !== "object") return null;
	const o = out as Record<string, unknown>;
	if (Array.isArray(o.content)) {
		const text = (o.content as Array<{ type?: string; text?: unknown }>).find(
			(c) => c.type === "text",
		)?.text;
		if (typeof text === "string") {
			try {
				return JSON.parse(text) as Record<string, unknown>;
			} catch {
				return null;
			}
		}
	}
	return o;
}

function stringOr(v: unknown, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}
function numberOr(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Slice the points array down to a given trailing range, anchored to
 *  the LAST point's timestamp (not `Date.now()`, so historical data
 *  filters consistently regardless of clock). */
export function sliceRange(points: ChartPoint[], range: Range): ChartPoint[] {
	if (points.length === 0) return points;
	const cutoff = points[points.length - 1]!.t - RANGE_MS[range];
	return points.filter((p) => p.t >= cutoff);
}

export interface PlotGeometry {
	width: number;
	height: number;
	padTop: number;
	padRight: number;
	padBottom: number;
	padLeft: number;
}

export interface PlotResult {
	/** SVG path d-attribute for the line. */
	linePath: string;
	/** SVG path d-attribute for the area beneath the line (line→baseline→close). */
	areaPath: string;
	/** Points in pixel space, in series order — used for hover hit detection. */
	pixelPoints: Array<{ x: number; y: number; t: number; v: number }>;
	/** Min/max prices in the slice. */
	minV: number;
	maxV: number;
	/** Min/max timestamps in the slice. */
	minT: number;
	maxT: number;
}

/** Map a series to SVG pixel coordinates + cached line/area paths. */
export function buildPlot(points: ChartPoint[], g: PlotGeometry): PlotResult {
	const innerW = g.width - g.padLeft - g.padRight;
	const innerH = g.height - g.padTop - g.padBottom;
	let minV = Infinity;
	let maxV = -Infinity;
	let minT = Infinity;
	let maxT = -Infinity;
	for (const p of points) {
		if (p.v < minV) minV = p.v;
		if (p.v > maxV) maxV = p.v;
		if (p.t < minT) minT = p.t;
		if (p.t > maxT) maxT = p.t;
	}
	// Avoid div-by-zero when the slice has a single point or all same value.
	const tSpan = maxT - minT || 1;
	const vSpan = maxV - minV || Math.max(1, Math.abs(maxV) * 0.01);
	const pixelPoints = points.map((p) => ({
		x: g.padLeft + ((p.t - minT) / tSpan) * innerW,
		y: g.padTop + (1 - (p.v - minV) / vSpan) * innerH,
		t: p.t,
		v: p.v,
	}));
	const linePath = pixelPoints
		.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
		.join(" ");
	const baselineY = g.padTop + innerH;
	const first = pixelPoints[0];
	const last = pixelPoints[pixelPoints.length - 1];
	const areaPath = first && last
		? `${linePath} L${last.x.toFixed(2)},${baselineY.toFixed(2)} L${first.x.toFixed(2)},${baselineY.toFixed(2)} Z`
		: "";
	return { linePath, areaPath, pixelPoints, minV, maxV, minT, maxT };
}

/** Nearest-X hit test for hover tooltip. */
export function nearestPoint(
	pixelPoints: Array<{ x: number; y: number; t: number; v: number }>,
	x: number,
): { x: number; y: number; t: number; v: number } | null {
	if (pixelPoints.length === 0) return null;
	let best = pixelPoints[0]!;
	let bestDist = Math.abs(best.x - x);
	for (let i = 1; i < pixelPoints.length; i++) {
		const d = Math.abs(pixelPoints[i]!.x - x);
		if (d < bestDist) {
			bestDist = d;
			best = pixelPoints[i]!;
		}
	}
	return best;
}

/** Format an ISO date string `YYYY-MM-DD` from epoch ms (UTC).
 *  Locale-free so SSR + client render the same string and the test
 *  is timezone-independent. */
export function formatDate(t: number): string {
	return new Date(t).toISOString().slice(0, 10);
}

/** Format `<currency> <amount>` with 2 decimals, en-US grouping. */
export function formatPrice(currency: string, amount: number): string {
	return `${currency} ${amount.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

/** Format `+1.23` / `-4.56` with sign. */
export function formatSignedDelta(delta: number, fractionDigits = 2): string {
	const sign = delta >= 0 ? "+" : "";
	return `${sign}${delta.toFixed(fractionDigits)}`;
}

/** Compute the headline change between two prices. */
export function computeChange(
	lastPrice: number,
	prevClose: number,
): { abs: number; pct: number; isUp: boolean } {
	const abs = lastPrice - prevClose;
	const pct = prevClose === 0 ? 0 : (abs / prevClose) * 100;
	return { abs, pct, isUp: abs >= 0 };
}
