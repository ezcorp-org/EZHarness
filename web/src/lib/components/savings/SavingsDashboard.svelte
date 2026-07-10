<script lang="ts">
	/**
	 * Savings-analytics dashboard, shared by the global
	 * (`/analytics/savings`) and project-scoped (`/project/[id]/savings`)
	 * pages. The pages differ only in heading + endpoint, so the fetch
	 * state machine lives HERE (DRY): SSR-provided `initial` data is the
	 * first paint anchor; when it's absent (DB-less e2e preview, or a
	 * transient API error during SSR) the component hydrates client-side
	 * on mount, and every range change refetches (admin-dashboard
	 * pattern).
	 *
	 * Honest-negatives rule: net savings CAN be negative (caching /
	 * routing that cost more than it saved). Negative $ values render
	 * with an explicit minus sign in the danger accent — never clamped
	 * or hidden. Bars scale by absolute magnitude, colored by sign.
	 */
	import { onMount } from "svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import {
		DEFAULT_RANGE_DAYS,
		RANGE_OPTIONS,
		barScaleMax,
		barWidthPct,
		fmtHitRate,
		fmtTokens,
		fmtUsd,
		isLoss,
		subscriptionNote,
		type SavingsPerModel,
		type SavingsResponse,
	} from "$lib/savings-format";

	let {
		heading,
		endpoint,
		initial = null,
		initialRange = DEFAULT_RANGE_DAYS,
	}: {
		heading: string;
		/** Builds the fetch URL for a given range (global vs project endpoint). */
		endpoint: (days: number) => string;
		/** SSR-loaded first paint data; null → fetch client-side on mount. */
		initial?: SavingsResponse | null;
		initialRange?: number;
	} = $props();

	// Deliberate initial-value capture: `initial`/`initialRange` seed the
	// local state once (SSR anchor); later changes flow through refetch.
	// svelte-ignore state_referenced_locally
	let savings = $state<SavingsResponse | null>(initial);
	// svelte-ignore state_referenced_locally
	let rangeDays = $state(initialRange);
	let loading = $state(false);
	let loadError = $state(false);
	// Monotonic fetch token: a stale (superseded) response must never win —
	// without it, a slow earlier range response arriving out of order would
	// overwrite the newer one and show old-range numbers under the newly
	// active range button (dishonest labeling).
	let fetchSeq = 0;

	async function refetch() {
		const seq = ++fetchSeq;
		loading = true;
		loadError = false;
		try {
			const res = await fetch(endpoint(rangeDays));
			const body = res.ok ? ((await res.json()) as SavingsResponse) : null;
			if (seq !== fetchSeq) return; // superseded by a newer selection
			if (body) savings = body;
			else loadError = true;
		} catch {
			if (seq === fetchSeq) loadError = true;
		} finally {
			if (seq === fetchSeq) loading = false;
		}
	}

	function selectRange(days: number) {
		rangeDays = days;
		void refetch();
	}

	onMount(() => {
		if (!savings) void refetch();
	});

	let stats = $derived(savings?.stats ?? null);
	let perModel = $derived(savings?.perModel ?? []);
	let isEmpty = $derived(
		savings !== null && savings.stats.turnsTotal === 0 && savings.perModel.length === 0,
	);
	// Bar scaling: $derived max over ABSOLUTE values so losses fill by
	// magnitude (admin-dashboard scaling convention).
	let cacheScale = $derived(barScaleMax(perModel.map((m) => m.cacheSavedUsd)));
	let routingScale = $derived(barScaleMax(perModel.map((m) => m.routingSavedUsd)));
</script>

{#snippet statCard(
	key: string,
	label: string,
	value: string,
	opts: { negative?: boolean; est?: boolean; sub?: string },
)}
	<div class="stat-card" data-testid={`savings-stat-${key}`}>
		<div
			class="stat-value {opts.negative ? 'neg' : ''}"
			data-testid={`savings-stat-${key}-value`}
			data-negative={opts.negative ? "true" : "false"}
		>
			{value}{#if opts.est}<span
					class="est-badge"
					title="Estimated from provider list prices — actual billing may differ">est.</span
				>{/if}
		</div>
		<div class="stat-label">{label}</div>
		{#if opts.sub}<div class="stat-sub">{opts.sub}</div>{/if}
	</div>
{/snippet}

{#snippet modelPanel(
	title: string,
	kind: string,
	rows: SavingsPerModel[],
	scale: number,
	value: (r: SavingsPerModel) => number,
)}
	<div class="section" data-testid={`savings-models-${kind}`}>
		<h3 class="section-title">{title}</h3>
		<div class="h-bar-list">
			{#each rows as row (row.provider + row.model)}
				{@const v = value(row)}
				<div class="h-bar-row" data-testid={`savings-model-row-${kind}`}>
					<span
						class="h-bar-label"
						title={`${row.model} (${row.provider}) · ${row.turns} turn${row.turns === 1 ? "" : "s"} · ${fmtTokens(row.tokensCachedRead)} tok cached · hit ${fmtHitRate(row.cacheHitRate)}`}
					>
						{row.model}
						<span class="text-muted">({row.provider})</span>
						{#if row.estimated}<span class="est-badge">est.</span>{/if}
					</span>
					<div class="h-bar-track">
						<div
							class="h-bar-fill {isLoss(v) ? 'neg' : ''}"
							style="width: {barWidthPct(v, scale)}%"
						></div>
					</div>
					<span
						class="h-bar-value {isLoss(v) ? 'neg' : ''}"
						data-negative={isLoss(v) ? "true" : "false"}>{fmtUsd(v)}</span
					>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<div class="savings" data-testid="savings-dashboard">
	<div class="savings-header">
		<h2 class="savings-title">{heading}</h2>
		<div class="range-bar" role="group" aria-label="Time range">
			{#each RANGE_OPTIONS as days (days)}
				<button
					class="range-btn {rangeDays === days ? 'active' : ''}"
					data-testid={`savings-range-${days}`}
					aria-pressed={rangeDays === days}
					onclick={() => selectRange(days)}
				>
					{days}d
				</button>
			{/each}
		</div>
	</div>

	{#if loadError}
		<div class="source-error" data-testid="savings-error">
			<span class="source-error-text">Failed to load savings.</span>
			<button class="source-error-retry" onclick={() => void refetch()}>Retry</button>
		</div>
	{:else if loading || !savings}
		<SkeletonLoader type="card-grid" count={5} />
	{:else if isEmpty}
		<p class="empty-text" data-testid="savings-empty">No usage in range.</p>
	{:else if stats}
		<div class="stat-grid" data-testid="savings-stat-grid">
			{@render statCard("cache", "Cache saved", fmtUsd(stats.cacheSavedUsd), {
				negative: isLoss(stats.cacheSavedUsd),
				est: true,
				sub: `reads ${fmtUsd(stats.cacheReadSavedUsd)} · write surcharge ${fmtUsd(stats.cacheWriteSurchargeUsd)}`,
			})}
			{@render statCard("routing", "Routing saved (est.)", fmtUsd(stats.routingSavedUsd), {
				negative: isLoss(stats.routingSavedUsd),
				est: true,
				sub: `${stats.turnsRouted}/${stats.turnsTotal} turns routed · ${stats.turnsFailover} failover`,
			})}
			{@render statCard("tokens", "Tokens cached", fmtTokens(stats.tokensCachedRead), {
				sub: `written ${fmtTokens(stats.tokensCacheWritten)}`,
			})}
			{@render statCard("hitrate", "Hit rate", fmtHitRate(stats.cacheHitRate), {})}
			{@render statCard("premium", "1h-write premium paid", fmtUsd(stats.write1hPremiumUsd), {
				est: true,
			})}
		</div>

		{#if savings.subscriptionProviders.length > 0}
			<div class="sub-note" data-testid="savings-subscription-note">
				{#each savings.subscriptionProviders as p (p)}
					<span>{subscriptionNote(p)}</span>
				{/each}
			</div>
		{/if}

		{@render modelPanel(
			"Cache savings by model",
			"cache",
			perModel,
			cacheScale,
			(r) => r.cacheSavedUsd,
		)}
		{@render modelPanel(
			"Routing savings by model (est.)",
			"routing",
			perModel,
			routingScale,
			(r) => r.routingSavedUsd,
		)}

		<p class="disclaimer">
			$ figures are estimates from provider list prices — token counts are exact. Negative
			values mean the feature cost more than it saved in this range.
		</p>
	{/if}
</div>

<style>
	.savings {
		max-width: 1200px;
	}
	.savings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}
	.savings-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text-primary);
	}

	/* Range selector */
	.range-bar {
		display: flex;
		gap: 0.25rem;
	}
	.range-btn {
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text-muted);
		background: var(--color-surface-secondary);
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		cursor: pointer;
		transition:
			color 0.15s,
			border-color 0.15s;
	}
	.range-btn:hover {
		color: var(--color-text-primary);
	}
	.range-btn.active {
		color: var(--color-text-primary);
		border-color: var(--color-primary, #3b82f6);
	}

	/* Stat cards grid (admin-dashboard convention) */
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	@media (min-width: 900px) {
		.stat-grid {
			grid-template-columns: repeat(5, 1fr);
		}
	}
	.stat-card {
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		padding: 1.25rem;
		background: var(--color-surface-secondary);
	}
	.stat-value {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-text-primary);
		line-height: 1.2;
	}
	/* Honest-negative accent: losses are loud, not hidden. */
	.stat-value.neg {
		color: var(--color-error, #ef4444);
	}
	.stat-label {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin-top: 0.25rem;
	}
	.stat-sub {
		font-size: 0.6875rem;
		color: var(--color-text-muted);
		margin-top: 0.375rem;
	}
	.est-badge {
		font-size: 0.5625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--color-text-muted);
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.0625rem 0.25rem;
		margin-left: 0.375rem;
		vertical-align: middle;
	}

	/* Subscription note */
	.sub-note {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		background: var(--color-surface-secondary);
		padding: 0.625rem 0.875rem;
		margin-bottom: 1.5rem;
	}

	/* Sections + horizontal bar list (admin-dashboard convention) */
	.section {
		margin-bottom: 2rem;
	}
	.section-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin-bottom: 0.75rem;
	}
	.h-bar-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.h-bar-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.h-bar-label {
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		width: 140px;
		flex: 0 0 140px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@media (min-width: 768px) {
		.h-bar-label {
			width: 280px;
			flex: 0 0 280px;
		}
	}
	.h-bar-track {
		flex: 1;
		height: 0.5rem;
		background: var(--color-surface-tertiary);
		border-radius: 0.25rem;
		overflow: hidden;
	}
	.h-bar-fill {
		height: 100%;
		background: var(--color-primary, #3b82f6);
		border-radius: 0.25rem;
		transition: width 0.3s ease;
	}
	.h-bar-fill.neg {
		background: var(--color-error, #ef4444);
	}
	.h-bar-value {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		width: 5rem;
		flex: 0 0 5rem;
		text-align: right;
	}
	.h-bar-value.neg {
		color: var(--color-error, #ef4444);
	}

	.disclaimer {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		font-style: italic;
	}
	.empty-text {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		font-style: italic;
	}

	/* Per-source inline error + retry (admin-dashboard convention) */
	.source-error {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		padding: 0.75rem 0;
	}
	.source-error-retry {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-primary, #3b82f6);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	.text-muted {
		color: var(--color-text-muted);
	}
</style>
