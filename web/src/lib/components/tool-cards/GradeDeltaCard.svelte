<!--
  GradeDeltaCard — renders the graded-card-scanner `identify_slab`
  output (`cardType: "grade-delta-chart"`): a header (grader badge +
  cert + identity title), an inline-SVG grouped bar chart — one group
  per grading company, one bar per adjacent-grade step, bar height =
  |pct| — and a compact price-per-grade table.

  Pure client-side; no network. Null-safe by design: companies with
  fewer than two priced grades carry no deltas (the backend omits them)
  so they are absent from the chart but still listed in the table;
  missing prices render "N/A" (never $0). Known degradations surface an
  actionable hint (e.g. identity stamped "psa-api:no-token" → how to
  save a free PSA token); unknown stamps show nothing. Style follows
  the PriceChartCard conventions (article.card + scoped CSS variables).
-->

<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import {
		buildDeltaChart,
		buildPriceTable,
		formatPrice,
		identityTitle,
		parseGradeDeltaPayload,
	} from "./grade-delta-logic";

	let { toolCall }: { toolCall: ToolCallState } = $props();

	let payload = $derived(parseGradeDeltaPayload(toolCall.output));

	const PLOT = {
		width: 480,
		height: 190,
		padTop: 26,
		padBottom: 34,
		padX: 12,
		groupGap: 28,
		barGap: 8,
	};

	let chart = $derived(payload ? buildDeltaChart(payload.deltas, PLOT) : null);
	let table = $derived(payload ? buildPriceTable(payload.grades) : null);
	let title = $derived(payload ? identityTitle(payload.identity) : "");
</script>

{#if !payload}
	<div class="error" role="alert" data-testid="grade-delta-missing">
		<strong>Cannot render slab card:</strong> tool output is missing required fields.
	</div>
{:else}
	<article class="card" aria-label="Graded-card slab identification" data-testid="grade-delta-card">
		<header class="head">
			<span
				class="badge"
				class:unknown={payload.grader === "unknown"}
				data-testid="grade-delta-grader"
			>{payload.grader}</span>
			{#if payload.cert}
				<span class="cert" data-testid="grade-delta-cert">#{payload.cert}</span>
			{/if}
			<div class="title" data-testid="grade-delta-title">
				{#if title}
					{title}{#if payload.identity.grade}&nbsp;· {payload.identity.grade}{/if}
				{:else if payload.grader === "unknown"}
					Slab not identified
				{:else}
					Identity unavailable
				{/if}
			</div>
		</header>

		{#if payload.hint}
			<p class="hint" data-testid="grade-delta-hint">{payload.hint}</p>
		{/if}

		{#if chart}
			<svg
				viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
				preserveAspectRatio="none"
				role="img"
				aria-label="Adjacent-grade price steps per grading company"
				data-testid="grade-delta-chart"
			>
				{#each chart.bars as bar (bar.stepLabel)}
					<rect
						class="bar"
						class:dn={bar.negative}
						x={bar.x}
						y={bar.y}
						width={bar.w}
						height={bar.h}
						rx="2"
						data-testid="grade-delta-bar"
					>
						<title>{`${bar.stepLabel} ${bar.pctLabel}`}</title>
					</rect>
					<text class="pct" x={bar.x + bar.w / 2} y={bar.y - 5} text-anchor="middle">
						{bar.pctLabel}
					</text>
					<text
						class="step"
						x={bar.x + bar.w / 2}
						y={PLOT.height - PLOT.padBottom + 12}
						text-anchor="middle"
					>
						{bar.stepLabel.split(" ")[1]}
					</text>
				{/each}
				{#each chart.groups as group (group.company)}
					<text
						class="company"
						x={group.xCenter}
						y={PLOT.height - 6}
						text-anchor="middle"
						data-testid="grade-delta-group"
					>
						{group.company}
					</text>
				{/each}
			</svg>
		{:else}
			<p class="no-chart" data-testid="grade-delta-no-chart">
				No adjacent-grade price pairs to chart.
			</p>
		{/if}

		{#if table}
			<table class="prices" data-testid="grade-delta-table">
				<thead>
					<tr>
						<th>Grade</th>
						{#each table.companies as company (company)}
							<th>{company}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each table.rows as row (row.grade)}
						<tr>
							<td class="grade">{row.grade}</td>
							{#each row.prices as price, i (`${row.grade}-${table.companies[i]}`)}
								<td class="price" class:na={price === null}>{formatPrice(price)}</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</article>
{/if}

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
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
		gap: 0.625rem;
		min-width: 0;
	}
	.badge {
		flex: 0 0 auto;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		background: var(--color-primary, #2563eb);
		color: #fff;
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}
	.badge.unknown {
		background: #4b5563;
	}
	.cert {
		flex: 0 0 auto;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #9ca3af);
		font-variant-numeric: tabular-nums;
	}
	.title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	svg {
		display: block;
		width: 100%;
		height: 190px;
	}
	.bar {
		fill: #10b981;
	}
	.bar.dn {
		fill: #ef4444;
	}
	.pct {
		fill: var(--color-text, #e5e7eb);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}
	.step {
		fill: var(--color-text-muted, #9ca3af);
		font-size: 9px;
	}
	.company {
		fill: var(--color-text-muted, #9ca3af);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
	}
	.no-chart {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #9ca3af);
	}
	.hint {
		margin: 0;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 6px;
		background: color-mix(in srgb, var(--color-primary, #2563eb) 8%, transparent);
		font-size: 0.8125rem;
		color: var(--color-text-muted, #9ca3af);
	}
	.prices {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}
	.prices th {
		text-align: right;
		padding: 0.25rem 0.5rem;
		color: var(--color-text-muted, #9ca3af);
		font-weight: 500;
		border-bottom: 1px solid var(--color-border, #2a2a2a);
	}
	.prices th:first-child {
		text-align: left;
	}
	.prices td {
		padding: 0.25rem 0.5rem;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.prices td.grade {
		text-align: left;
		color: var(--color-text-muted, #9ca3af);
	}
	.prices td.na {
		color: var(--color-text-muted, #6b7280);
	}
</style>
