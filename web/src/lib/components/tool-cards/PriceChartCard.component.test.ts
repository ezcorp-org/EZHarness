/**
 * DOM tests for PriceChartCard.svelte.
 *
 * Covers the contract the price-chart extension's UI surface needs:
 *   - Renders the header row (logo / symbol / name / price / change).
 *   - Default range tab is 1Y.
 *   - Clicking a range tab updates `aria-selected` AND re-derives the
 *     headline % change off the visible slice.
 *   - The accent color (line stroke + headline class + gradient stops)
 *     is driven by a single source of truth — pinning the regression
 *     where the bar showed green while the chart line stayed red.
 *   - Each card instance gets a unique SVG gradient `id`, so two
 *     PriceChartCards mounted side-by-side don't shadow each other's
 *     fill (regression pin for the gradient-id collision bug).
 *   - Missing / malformed payload renders the inline error.
 *   - Hover over the chart shows a tooltip with date + price.
 *   - When `logoUrl` is empty, the placeholder square shows the first
 *     letter of the symbol; when `logoUrl` 404s, `<img onerror>` hides
 *     the broken image.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import PriceChartCard from "./PriceChartCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

// ── Helpers ────────────────────────────────────────────────────────

interface PayloadInput {
	symbol?: string;
	name?: string;
	logoUrl?: string;
	currency?: string;
	kind?: "stock" | "crypto";
	lastPrice?: number;
	prevClose?: number;
	/** Pass an explicit point series, OR a `direction` + `count` to
	 *  synthesize a synthetic series. */
	points?: Array<{ t: number; v: number }>;
	direction?: "up" | "down" | "mixed";
	count?: number;
}

const BASE_T = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;

function synthSeries(direction: "up" | "down" | "mixed", count: number) {
	const out: Array<{ t: number; v: number }> = [];
	for (let i = 0; i < count; i++) {
		let v: number;
		if (direction === "up") v = 100 + i;
		else if (direction === "down") v = 200 - i;
		else v = 150 + Math.sin(i / 5) * 10;
		out.push({ t: BASE_T + i * DAY, v });
	}
	return out;
}

function makeToolCall(p: PayloadInput = {}): ToolCallState {
	const points = p.points ?? synthSeries(p.direction ?? "up", p.count ?? 365);
	const first = points[0]!.v;
	const last = points[points.length - 1]!.v;
	const payload = {
		_assistant_note: "Chart rendered.",
		kind: p.kind ?? "stock",
		symbol: p.symbol ?? "AAPL",
		name: p.name ?? "Apple Inc.",
		logoUrl: p.logoUrl ?? "https://logo.clearbit.com/apple.com",
		currency: p.currency ?? "USD",
		lastPrice: p.lastPrice ?? last,
		prevClose: p.prevClose ?? first,
		points,
	};
	return {
		id: "tc-test",
		toolName: "price-chart__get_stock_chart",
		status: "complete",
		input: { ticker: p.symbol ?? "AAPL" },
		startedAt: 0,
		duration: 200,
		cardType: "price-chart",
		output: JSON.stringify(payload),
	};
}

afterEach(() => cleanup());

// ── Header + initial state ─────────────────────────────────────────

describe("PriceChartCard — header + default state", () => {
	test("renders symbol, name, logo, current price", () => {
		const { getByTestId, getByAltText } = render(PriceChartCard, {
			toolCall: makeToolCall({ symbol: "AAPL", name: "Apple Inc.", lastPrice: 290.5 }),
		});
		expect(getByTestId("price-chart-symbol").textContent).toBe("AAPL");
		expect(getByTestId("price-chart-name").textContent).toBe("Apple Inc.");
		expect(getByTestId("price-chart-last").textContent).toBe("USD 290.50");
		const logo = getByAltText("AAPL logo") as HTMLImageElement;
		expect(logo.src).toBe("https://logo.clearbit.com/apple.com");
	});

	test("default range tab is 1Y", () => {
		const { getByTestId } = render(PriceChartCard, { toolCall: makeToolCall() });
		expect(getByTestId("price-chart-range-1y").getAttribute("aria-selected")).toBe("true");
		expect(getByTestId("price-chart-range-1w").getAttribute("aria-selected")).toBe("false");
	});

	test("logo placeholder shows when logoUrl is empty", () => {
		const { queryByAltText, container } = render(PriceChartCard, {
			toolCall: makeToolCall({ logoUrl: "", symbol: "ZZZZ" }),
		});
		expect(queryByAltText("ZZZZ logo")).toBeNull();
		const placeholder = container.querySelector(".logo-placeholder");
		expect(placeholder).not.toBeNull();
		expect(placeholder!.textContent?.trim()).toBe("Z");
	});

	test("logo <img> hides itself on load error (broken Clearbit URL)", () => {
		const { getByAltText } = render(PriceChartCard, {
			toolCall: makeToolCall({ symbol: "AAPL", logoUrl: "https://broken.example/logo.png" }),
		});
		const img = getByAltText("AAPL logo") as HTMLImageElement;
		fireEvent.error(img);
		expect(img.style.display).toBe("none");
	});
});

// ── Range switching + change derivation ────────────────────────────

describe("PriceChartCard — range switching", () => {
	test("clicking a range tab updates aria-selected", async () => {
		const { getByTestId } = render(PriceChartCard, { toolCall: makeToolCall() });
		await fireEvent.click(getByTestId("price-chart-range-1w"));
		expect(getByTestId("price-chart-range-1w").getAttribute("aria-selected")).toBe("true");
		expect(getByTestId("price-chart-range-1y").getAttribute("aria-selected")).toBe("false");
	});

	test("headline % change refreshes when range switches", async () => {
		// Year is strictly up; last 7 days are strictly DOWN (200 → 194).
		const series: Array<{ t: number; v: number }> = [];
		for (let i = 0; i < 358; i++) series.push({ t: BASE_T + i * DAY, v: 100 + i * 0.279 });
		for (let i = 0; i < 7; i++) series.push({ t: BASE_T + (358 + i) * DAY, v: 200 - i });
		const { getByTestId } = render(PriceChartCard, {
			toolCall: makeToolCall({ points: series }),
		});
		// 1Y: clearly positive (~+94%).
		const yChange = getByTestId("price-chart-change").textContent ?? "";
		expect(yChange).toContain("+");
		expect(yChange).not.toMatch(/^-/);

		// 1W: clearly negative.
		await fireEvent.click(getByTestId("price-chart-range-1w"));
		const wChange = getByTestId("price-chart-change").textContent ?? "";
		expect(wChange).toMatch(/^-/);
	});
});

// ── Accent-color synchronization (regression pin) ──────────────────

describe("PriceChartCard — accent color synchronization", () => {
	test("when slice is up, bar uses .up class AND line stroke is green", () => {
		const { getByTestId, container } = render(PriceChartCard, {
			toolCall: makeToolCall({ direction: "up", count: 365 }),
		});
		expect(getByTestId("price-chart-change").classList.contains("up")).toBe(true);
		const linePath = container.querySelector("path[fill='none']");
		expect(linePath?.getAttribute("stroke")).toBe("#10b981");
	});

	test("when slice is down, bar uses .dn class AND line stroke is red", () => {
		const { getByTestId, container } = render(PriceChartCard, {
			toolCall: makeToolCall({ direction: "down", count: 365 }),
		});
		expect(getByTestId("price-chart-change").classList.contains("dn")).toBe(true);
		const linePath = container.querySelector("path[fill='none']");
		expect(linePath?.getAttribute("stroke")).toBe("#ef4444");
	});

	test("range switch from up → down flips line stroke at the same time as the bar class", async () => {
		// 1Y is up overall; last 7 days are strictly down.
		const series: Array<{ t: number; v: number }> = [];
		for (let i = 0; i < 358; i++) series.push({ t: BASE_T + i * DAY, v: 100 + i });
		for (let i = 0; i < 7; i++) series.push({ t: BASE_T + (358 + i) * DAY, v: 458 - i });
		const { getByTestId, container } = render(PriceChartCard, {
			toolCall: makeToolCall({ points: series }),
		});
		// Sanity check on 1Y: bar up, line green.
		expect(getByTestId("price-chart-change").classList.contains("up")).toBe(true);
		expect(container.querySelector("path[fill='none']")?.getAttribute("stroke")).toBe("#10b981");

		await fireEvent.click(getByTestId("price-chart-range-1w"));
		expect(getByTestId("price-chart-change").classList.contains("dn")).toBe(true);
		expect(container.querySelector("path[fill='none']")?.getAttribute("stroke")).toBe("#ef4444");
	});
});

// ── Unique gradient ID per instance (regression pin) ───────────────

describe("PriceChartCard — gradient id is per-instance", () => {
	test("two cards rendered together have distinct linearGradient ids", () => {
		const a = render(PriceChartCard, { toolCall: makeToolCall({ symbol: "AAPL" }) });
		const b = render(PriceChartCard, { toolCall: makeToolCall({ symbol: "MSFT" }) });
		const idA = a.container.querySelector("linearGradient")?.getAttribute("id") ?? "";
		const idB = b.container.querySelector("linearGradient")?.getAttribute("id") ?? "";
		expect(idA).toMatch(/^pc-area-grad-/);
		expect(idB).toMatch(/^pc-area-grad-/);
		expect(idA).not.toBe(idB);
		// Each card's area path references its OWN gradient (no cross-pollution).
		const areaA = a.container.querySelector("path[fill^='url']");
		const areaB = b.container.querySelector("path[fill^='url']");
		expect(areaA?.getAttribute("fill")).toBe(`url(#${idA})`);
		expect(areaB?.getAttribute("fill")).toBe(`url(#${idB})`);
	});
});

// ── Hover tooltip ──────────────────────────────────────────────────

describe("PriceChartCard — hover tooltip", () => {
	test("mousemove over the SVG shows tooltip; mouseleave hides it", async () => {
		const { queryByTestId, getByRole } = render(PriceChartCard, {
			toolCall: makeToolCall({ direction: "up", count: 30 }),
		});
		expect(queryByTestId("price-chart-tooltip")).toBeNull();
		const svg = getByRole("img", { name: "price history" }) as unknown as SVGSVGElement;
		// jsdom doesn't lay out SVG, so getBoundingClientRect returns 0×0;
		// the nearest-point math falls back to `pixelPoints[0]` (index 0,
		// closest x to 0). That's still a valid hover state to render.
		await fireEvent.mouseMove(svg, { clientX: 0, clientY: 0 });
		const tip = queryByTestId("price-chart-tooltip");
		expect(tip).not.toBeNull();
		expect(tip!.textContent).toMatch(/USD/);
		await fireEvent.mouseLeave(svg);
		expect(queryByTestId("price-chart-tooltip")).toBeNull();
	});
});

// ── Error fallback ─────────────────────────────────────────────────

describe("PriceChartCard — error states", () => {
	test("missing output renders error card", () => {
		const tc: ToolCallState = {
			id: "tc-bad",
			toolName: "price-chart__get_stock_chart",
			status: "complete",
			input: {},
			startedAt: 0,
			cardType: "price-chart",
			output: null as unknown as string,
		};
		const { getByTestId } = render(PriceChartCard, { toolCall: tc });
		expect(getByTestId("price-chart-missing").textContent).toMatch(/Cannot render chart/);
	});

	test("malformed JSON output renders error card", () => {
		const tc: ToolCallState = {
			id: "tc-bad",
			toolName: "price-chart__get_stock_chart",
			status: "complete",
			input: {},
			startedAt: 0,
			cardType: "price-chart",
			output: "not json at all",
		};
		const { getByTestId } = render(PriceChartCard, { toolCall: tc });
		expect(getByTestId("price-chart-missing")).not.toBeNull();
	});

	test("payload with empty points renders error card", () => {
		const tc: ToolCallState = {
			id: "tc-empty",
			toolName: "price-chart__get_stock_chart",
			status: "complete",
			input: {},
			startedAt: 0,
			cardType: "price-chart",
			output: JSON.stringify({
				kind: "stock", symbol: "X", name: "X", logoUrl: "", currency: "USD",
				lastPrice: 1, prevClose: 1, points: [],
			}),
		};
		const { getByTestId } = render(PriceChartCard, { toolCall: tc });
		expect(getByTestId("price-chart-missing")).not.toBeNull();
	});
});
