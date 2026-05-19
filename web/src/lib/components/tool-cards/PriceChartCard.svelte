<!--
  PriceChartCard — renders the price-chart extension's output as an
  inline SVG line chart. Receives `{symbol, name, logoUrl, currency,
  lastPrice, prevClose, points}` from the tool result and renders:

    - header row: logo + ticker + name + last price + % change
    - range tabs (1W / 1M / 3M / 1Y) — pure client-side filter
    - SVG area chart with axis labels + hover tooltip

  No iframe. No on-disk HTML. No filesystem permission required from
  the extension subprocess — the chart is rendered entirely in the
  user's browser from the JSON payload the tool returns.
-->

<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import {
		RANGES,
		buildPlot,
		computeChange,
		formatDate,
		formatPrice,
		formatSignedDelta,
		nearestPoint,
		parsePayload,
		sliceRange,
		type Range,
	} from "./price-chart-logic";

	let { toolCall }: { toolCall: ToolCallState } = $props();

	let payload = $derived(parsePayload(toolCall.output));
	let range = $state<Range>("1y");

	let slice = $derived(payload ? sliceRange(payload.points, range) : []);

	const PLOT = {
		width: 480,
		height: 200,
		padTop: 8,
		padRight: 12,
		padBottom: 24,
		padLeft: 52,
	};

	let plot = $derived(buildPlot(slice, PLOT));
	// % change is anchored to the FIRST point of the *visible* slice so the
	// headline number updates when the user switches range. The displayed
	// `lastPrice` (header right column) stays as the latest data point.
	let change = $derived.by(() => {
		if (!payload || slice.length === 0) return { abs: 0, pct: 0, isUp: true };
		const first = slice[0]!.v;
		const last = slice[slice.length - 1]!.v;
		return computeChange(last, first);
	});
	// Single source of truth for the accent color. The bar text class, the
	// SVG line stroke, AND the area gradient stops all bind to this so the
	// three can't drift. (Previously each ternary expressed the same thing
	// independently, and one of them sometimes lagged a frame on range
	// switch.)
	const UP = "#10b981";
	const DOWN = "#ef4444";
	let accentColor = $derived(change.isUp ? UP : DOWN);
	// Per-instance gradient id. Two PriceChartCards in the same conversation
	// share a DOM and a hardcoded `pc-area-grad` id collides — the second
	// card's gradient definition is shadowed by the first, so its fill
	// inherits the WRONG color. `$props.id()` returns a token unique to
	// this instance and must be assigned directly (Svelte's parser rejects
	// it inside template literals). Building the id below from that token.
	const instanceId = $props.id();
	const gradId = `pc-area-grad-${instanceId}`;

	// Hover tooltip state.
	let hover = $state<{ x: number; y: number; t: number; v: number } | null>(null);
	let svgEl = $state<SVGSVGElement | undefined>(undefined);

	function onMove(ev: MouseEvent): void {
		if (!svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		// Translate client X into the SVG's viewBox X (the viewBox is fixed
		// at PLOT.width; the rendered width may be smaller / scaled).
		const scale = PLOT.width / rect.width;
		const x = (ev.clientX - rect.left) * scale;
		hover = nearestPoint(plot.pixelPoints, x);
	}

	function onLeave(): void {
		hover = null;
	}

	function onImgError(ev: Event): void {
		const img = ev.target as HTMLImageElement | null;
		if (img) img.style.display = "none";
	}

	// Pre-compute axis ticks so the template stays trim. Three Y ticks
	// (min / mid / max) and three X ticks (start / mid / end).
	let yTicks = $derived.by(() => {
		if (!payload || plot.pixelPoints.length === 0) return [];
		const mid = (plot.minV + plot.maxV) / 2;
		const ticks = [plot.maxV, mid, plot.minV];
		const innerH = PLOT.height - PLOT.padTop - PLOT.padBottom;
		const vSpan = plot.maxV - plot.minV || 1;
		return ticks.map((v) => ({
			v,
			y: PLOT.padTop + (1 - (v - plot.minV) / vSpan) * innerH,
		}));
	});

	let xTicks = $derived.by(() => {
		const pts = plot.pixelPoints;
		if (pts.length === 0) return [];
		const first = pts[0]!;
		const last = pts[pts.length - 1]!;
		const midIdx = Math.floor(pts.length / 2);
		const mid = pts[midIdx]!;
		return [first, mid, last].map((p) => ({ x: p.x, t: p.t }));
	});
</script>

{#if !payload}
	<div class="error" role="alert" data-testid="price-chart-missing">
		<strong>Cannot render chart:</strong> tool output is missing required fields.
	</div>
{:else}
	<article class="card" aria-label={`${payload.symbol} price chart`}>
		<header class="head">
			{#if payload.logoUrl}
				<img
					class="logo"
					src={payload.logoUrl}
					alt={`${payload.symbol} logo`}
					onerror={onImgError}
				/>
			{:else}
				<div class="logo logo-placeholder" aria-hidden="true">
					{payload.symbol.slice(0, 1).toUpperCase()}
				</div>
			{/if}
			<div class="title">
				<div class="sym" data-testid="price-chart-symbol">{payload.symbol}</div>
				<div class="name" data-testid="price-chart-name">{payload.name}</div>
			</div>
			<div class="price">
				<div class="last" data-testid="price-chart-last">
					{formatPrice(payload.currency, payload.lastPrice)}
				</div>
				<div
					class="chg"
					class:up={change.isUp}
					class:dn={!change.isUp}
					data-testid="price-chart-change"
				>
					{formatSignedDelta(change.abs)} ({formatSignedDelta(change.pct)}%)
				</div>
			</div>
		</header>

		<div class="ranges" role="tablist" aria-label="Time range">
			{#each RANGES as r (r)}
				<button
					type="button"
					role="tab"
					aria-selected={range === r}
					data-testid={`price-chart-range-${r}`}
					onclick={() => (range = r)}
				>{r.toUpperCase()}</button>
			{/each}
		</div>

		<div class="chart-wrap">
			<svg
				bind:this={svgEl}
				viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
				preserveAspectRatio="none"
				role="img"
				aria-label="price history"
				onmousemove={onMove}
				onmouseleave={onLeave}
			>
				<defs>
					<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color={accentColor} stop-opacity="0.35" />
						<stop offset="100%" stop-color={accentColor} stop-opacity="0" />
					</linearGradient>
				</defs>

				{#each yTicks as tick (tick.y)}
					<line
						class="grid"
						x1={PLOT.padLeft}
						y1={tick.y}
						x2={PLOT.width - PLOT.padRight}
						y2={tick.y}
					/>
					<text class="axis" x={PLOT.padLeft - 6} y={tick.y + 3} text-anchor="end">
						{tick.v.toFixed(2)}
					</text>
				{/each}

				{#if plot.areaPath}
					<path d={plot.areaPath} fill={`url(#${gradId})`} stroke="none" />
				{/if}
				{#if plot.linePath}
					<path
						d={plot.linePath}
						fill="none"
						stroke={accentColor}
						stroke-width="1.5"
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{/if}

				{#each xTicks as tick (tick.x)}
					<text class="axis" x={tick.x} y={PLOT.height - 6} text-anchor="middle">
						{formatDate(tick.t)}
					</text>
				{/each}

				{#if hover}
					<line
						class="hover-line"
						x1={hover.x}
						y1={PLOT.padTop}
						x2={hover.x}
						y2={PLOT.height - PLOT.padBottom}
					/>
					<circle class="hover-dot" cx={hover.x} cy={hover.y} r="3" />
				{/if}
			</svg>

			{#if hover}
				<div
					class="tooltip"
					style:left={`${(hover.x / PLOT.width) * 100}%`}
					data-testid="price-chart-tooltip"
				>
					<div class="tt-date">{formatDate(hover.t)}</div>
					<div class="tt-price">{formatPrice(payload.currency, hover.v)}</div>
				</div>
			{/if}
		</div>
	</article>
{/if}

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.875rem 1rem 1rem;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 8px;
		color: var(--color-text, #e5e7eb);
		font-family: system-ui, -apple-system, sans-serif;
	}
	.error {
		padding: 0.75rem 1rem;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 8px;
		color: var(--color-error, #ef4444);
		font-size: 0.875rem;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.logo {
		width: 40px;
		height: 40px;
		flex: 0 0 auto;
		border-radius: 8px;
		background: #1f2937;
		object-fit: contain;
	}
	.logo-placeholder {
		display: grid;
		place-items: center;
		font-weight: 700;
		color: #f3f4f6;
		font-size: 1.05rem;
	}
	.title {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.sym {
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	.name {
		font-size: 0.8125rem;
		color: var(--color-text-muted, #9ca3af);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.price {
		text-align: right;
		display: flex;
		flex-direction: column;
		font-variant-numeric: tabular-nums;
	}
	.last {
		font-size: 1rem;
		font-weight: 600;
	}
	.chg {
		font-size: 0.8125rem;
	}
	.chg.up { color: #10b981; }
	.chg.dn { color: #ef4444; }
	.ranges {
		display: flex;
		gap: 0.375rem;
	}
	.ranges button {
		flex: 0 0 auto;
		background: transparent;
		border: 1px solid var(--color-border, #374151);
		color: var(--color-text-muted, #9ca3af);
		border-radius: 6px;
		padding: 0.25rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.12s, color 0.12s, border-color 0.12s;
	}
	.ranges button:hover {
		color: var(--color-text, #e5e7eb);
		border-color: var(--color-border-strong, #4b5563);
	}
	.ranges button[aria-selected="true"] {
		background: var(--color-primary, #2563eb);
		color: #fff;
		border-color: var(--color-primary, #2563eb);
	}
	.chart-wrap {
		position: relative;
		width: 100%;
	}
	svg {
		display: block;
		width: 100%;
		height: 200px;
	}
	.grid {
		stroke: rgba(75, 85, 99, 0.25);
		stroke-width: 1;
		shape-rendering: crispEdges;
	}
	.axis {
		fill: var(--color-text-muted, #9ca3af);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}
	.hover-line {
		stroke: rgba(156, 163, 175, 0.5);
		stroke-width: 1;
		shape-rendering: crispEdges;
	}
	.hover-dot {
		fill: var(--color-text, #e5e7eb);
		stroke: var(--color-surface, #1a1a1a);
		stroke-width: 1.5;
	}
	.tooltip {
		position: absolute;
		top: 4px;
		transform: translateX(-50%);
		background: rgba(17, 24, 39, 0.95);
		border: 1px solid var(--color-border, #374151);
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		pointer-events: none;
		font-size: 0.75rem;
		white-space: nowrap;
	}
	.tt-date { color: var(--color-text-muted, #9ca3af); }
	.tt-price { font-weight: 600; }
</style>
