<!--
  CityConditionsCard — renders the city-conditions extension's aggregated
  result (`cardType: "city-conditions"`): place + place-LOCAL time, the
  current reading (temperature honouring the requested unit, feels-like,
  humidity, wind), the six pollen grains with their total index and band,
  and mold.

  This file is TEMPLATE ONLY. Every parse, conversion, and format lives in
  `city-conditions-card-logic.ts` and reaches us pre-computed on `view` —
  the component branches solely on booleans the logic module already
  decided. A failure message once hid inside an untestable `.svelte` file;
  it does not get to happen here.

  The honesty contract this markup carries:
    - mold ships `available: false` with a reason, and renders as an
      explicit "Not available" block SHOWING that reason — not a blank,
      not a 0, not a dash that reads like a measurement;
    - a grain the provider has no value for renders the words "Not
      reported" in the muted/unreported treatment, while a MEASURED zero
      renders as the number 0.0 in the normal numeric treatment — the two
      are never visually the same;
    - `ok:false` gets a readable failure block (code + message), so a
      failed run can never look like a successful empty one.

  Style follows GradeDeltaCard/PriceChartCard (article.card + scoped CSS
  custom properties). Every row wraps and every text cell sets `min-width:
  0`, so nothing collapses to zero width on a narrow mobile viewport.
-->

<script lang="ts">
	import type { CityConditionsView } from "./city-conditions-card-logic";

	let { view }: { view: CityConditionsView } = $props();
</script>

{#if view.kind === "failed"}
	<article class="card failed" role="alert" data-testid="city-conditions-failed">
		<header class="fail-head">
			<span class="fail-badge" data-testid="city-conditions-failure-code">{view.code}</span>
			<h3 class="fail-title">City conditions unavailable</h3>
		</header>
		<p class="fail-message" data-testid="city-conditions-failure-message">{view.message}</p>
	</article>
{:else}
	<article
		class="card"
		class:night={!view.isDay}
		aria-label={`Current conditions for ${view.placeName}`}
		data-testid="city-conditions-card"
	>
		<header class="head">
			<div class="place">
				<h3 class="place-name" data-testid="city-conditions-place">{view.placeLine}</h3>
				{#if view.timezone}
					<span class="tz" data-testid="city-conditions-timezone">{view.timezone}</span>
				{/if}
			</div>
			<div class="clock">
				<span class="clock-label">Local time</span>
				<span
					class="clock-value"
					class:unreported={!view.localTimeReported}
					data-testid="city-conditions-local-time"
					data-reported={view.localTimeReported}>{view.localTime}</span
				>
			</div>
		</header>

		<div class="now">
			<span class="temp" data-testid="city-conditions-temp">{view.temperature}</span>
			<span class="condition" data-testid="city-conditions-condition">{view.condition}</span>
		</div>

		<div class="stats">
			<div class="stat">
				<span class="stat-label">Feels like</span>
				<span class="stat-value" data-testid="city-conditions-feels-like">{view.feelsLike}</span>
			</div>
			<div class="stat">
				<span class="stat-label">Humidity</span>
				<span class="stat-value" data-testid="city-conditions-humidity">{view.humidity}</span>
			</div>
			<div class="stat">
				<span class="stat-label">Wind</span>
				<span class="stat-value" data-testid="city-conditions-wind">{view.wind}</span>
			</div>
		</div>

		<section class="panel" data-testid="city-conditions-pollen">
			<header class="panel-head">
				<h4 class="panel-title">Pollen <span class="unit">µg/m³</span></h4>
				<div class="total">
					<span
						class="total-value"
						class:unreported={!view.pollen.totalReported}
						data-testid="city-conditions-pollen-total"
						data-reported={view.pollen.totalReported}>{view.pollen.totalText}</span
					>
					<span
						class="band band-{view.pollen.bandId}"
						data-testid="city-conditions-pollen-band"
						data-band={view.pollen.bandId}>{view.pollen.bandLabel}</span
					>
				</div>
			</header>
			<ul class="grains">
				{#each view.pollen.grains as grain (grain.key)}
					<li class="grain" data-testid="city-conditions-grain" data-grain={grain.key}>
						<span class="grain-label">{grain.label}</span>
						<span
							class="grain-value"
							class:unreported={!grain.reported}
							data-testid="city-conditions-grain-value"
							data-reported={grain.reported}>{grain.text}</span
						>
					</li>
				{/each}
			</ul>
		</section>

		<section class="panel" data-testid="city-conditions-mold">
			<header class="panel-head">
				<h4 class="panel-title">Mold</h4>
			</header>
			{#if view.mold.available}
				<div class="mold-reading">
					<span class="mold-count" data-testid="city-conditions-mold-count">{view.mold.countText}</span>
					<span class="band band-reading" data-testid="city-conditions-mold-band">{view.mold.bandText}</span>
				</div>
			{:else}
				<div class="mold-missing" data-testid="city-conditions-mold-unavailable">
					<span class="mold-flag">Not available</span>
					<p class="mold-reason" data-testid="city-conditions-mold-reason">{view.mold.reason}</p>
				</div>
			{/if}
		</section>
	</article>
{/if}

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem 1rem 1rem;
		background: var(--color-surface, #ffffff);
		border: 1px solid var(--color-border, #d4dae8);
		border-radius: 8px;
		color: var(--color-text-primary, #11141f);
		font-family: system-ui, -apple-system, sans-serif;
		/* The card sits in a chat column whose width varies with the
		   sidebar, so the grids below size off the CARD, not the viewport.
		   A viewport media query would be measuring the wrong box. */
		container-type: inline-size;
	}
	/*
	  Night steps the card onto the deeper surface token, which resolves
	  correctly in BOTH themes. The reading itself is unchanged — this is
	  ambience, never a signal about the data.
	*/
	.card.night {
		background: var(--color-surface-secondary, #eef1f7);
	}

	/* ── Header ── */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
	}
	.place {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.place-name {
		margin: 0;
		min-width: 0;
		font-size: 1rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.tz {
		font-size: 0.75rem;
		color: var(--color-text-muted, #565d72);
		overflow-wrap: anywhere;
	}
	.clock {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.375rem;
		min-width: 0;
	}
	.clock-label {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-muted, #565d72);
	}
	.clock-value {
		font-size: 0.875rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	/* ── Current reading ── */
	.now {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		min-width: 0;
	}
	.temp {
		font-size: 2.25rem;
		font-weight: 300;
		line-height: 1.05;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
	}
	/* Secondary, not muted: the condition is real data, so it must sit
	   ABOVE the muted treatment that "Not reported" uses. */
	.condition {
		min-width: 0;
		font-size: 0.9375rem;
		color: var(--color-text-secondary, #434b5e);
		overflow-wrap: anywhere;
	}

	/* Three readings, three columns, always — an auto-fit track left a
	   dangling half-empty row on mobile. Values wrap inside their cell
	   rather than pushing the grid around. */
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--color-border, #d4dae8);
		border-radius: 6px;
	}
	.stat-label {
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-muted, #565d72);
	}
	.stat-value {
		font-size: 0.875rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	/* ── Panels (pollen, mold) ── */
	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border, #d4dae8);
	}
	.panel-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
	}
	.panel-title {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--color-text-muted, #565d72);
	}
	.unit {
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
	}
	.total {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.total-value {
		font-size: 1rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.band {
		flex: 0 1 auto;
		min-width: 0;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		overflow-wrap: anywhere;
		background: #374151;
		color: #e5e7eb;
	}
	.band-low {
		background: #065f46;
		color: #d1fae5;
	}
	.band-moderate {
		background: #78350f;
		color: #fef3c7;
	}
	.band-high {
		background: #7c2d12;
		color: #ffedd5;
	}
	.band-very-high {
		background: #7f1d1d;
		color: #fee2e2;
	}
	.band-reading {
		background: #1e3a8a;
		color: #dbeafe;
	}

	/* Six grains divide evenly by 2 AND 3, so the column count is pinned
	   rather than left to auto-fit — which produced a ragged 5+1 (then
	   4+2, with one cell wrapping taller than its neighbours). 2×3 when
	   the card is narrow, 3×2 once it has room. */
	.grains {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/*
	  Narrow: label STACKED over value. Side-by-side, "Mugwort" + "Not
	  reported" overflowed by a few pixels and wrapped, leaving that row
	  taller than its neighbours. Stacking is uniform for every grain
	  regardless of word length — no cell can be the odd one out.
	*/
	.grain {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		min-width: 0;
		padding: 0.375rem 0.5rem;
		border-radius: 6px;
		background: var(--color-surface-tertiary, #e0e5ef);
	}
	@container (min-width: 26rem) {
		.grains {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.grain {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: baseline;
			justify-content: space-between;
			gap: 0.25rem 0.5rem;
		}
	}
	.grain-label {
		min-width: 0;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #565d72);
		overflow-wrap: anywhere;
	}
	.grain-value {
		min-width: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	/*
	  The "no value here" treatment. Deliberately WORDS in italic muted
	  type, never a number: a grain the provider has no reading for must
	  not be mistakable for a measured 0.0, which renders in the normal
	  tabular numeric style above.
	*/
	.unreported {
		font-style: italic;
		font-weight: 500;
		font-variant-numeric: normal;
		color: var(--color-text-muted, #565d72);
	}

	/* ── Mold ── */
	.mold-reading {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.mold-count {
		font-size: 1rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.mold-missing {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.375rem;
		min-width: 0;
		padding: 0.5rem 0.625rem;
		border: 1px dashed var(--color-border-strong, #b7c0d4);
		border-radius: 6px;
	}
	.mold-flag {
		flex: 0 0 auto;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		background: #374151;
		color: #e5e7eb;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.03em;
	}
	/*
	  The reason is the whole point of the block, so it gets a full-width
	  wrapping paragraph — not a flex sibling that can be squeezed to zero
	  width next to the badge on a narrow viewport.
	*/
	.mold-reason {
		margin: 0;
		min-width: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary, #434b5e);
		overflow-wrap: anywhere;
	}

	/* ── ok:false ── */
	.card.failed {
		border-color: color-mix(
			in srgb,
			var(--color-red-600, #df3b39) 45%,
			var(--color-border, #d4dae8)
		);
	}
	.fail-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.fail-badge {
		flex: 0 1 auto;
		min-width: 0;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		background: var(--color-red-600, #df3b39);
		color: #fff;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		overflow-wrap: anywhere;
	}
	.fail-title {
		margin: 0;
		min-width: 0;
		font-size: 0.875rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.fail-message {
		margin: 0;
		min-width: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary, #434b5e);
		overflow-wrap: anywhere;
	}
</style>
