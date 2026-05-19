<script lang="ts">
	// Shown above ChatInput when the active run has gone quiet for long enough that the user
	// should be nudged. Two thresholds: "slow" (amber) and "stuck" (red). Both include an
	// elapsed counter and action buttons so the user is never trapped with a silent spinner.
	//
	// stalenessMs is the server-reported "time since last heartbeat" from GET /active-run.
	// startedAt is the run's start timestamp (ms since epoch) — used for wall-clock elapsed.

	let {
		stalenessMs,
		startedAt,
		onCancel,
		onOpenObservability,
	}: {
		stalenessMs: number;
		startedAt: number;
		onCancel: () => void;
		onOpenObservability: () => void;
	} = $props();

	const SLOW_THRESHOLD_MS = 30_000;
	const STUCK_THRESHOLD_MS = 60_000;

	// Tick a local wall-clock so the elapsed counter advances between polls. The banner
	// only renders when the parent passes stalenessMs above SLOW_THRESHOLD_MS, so we don't
	// need to worry about wasted ticks in the happy path.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(id);
	});

	let elapsedMs = $derived(now - startedAt);
	let severity = $derived(stalenessMs >= STUCK_THRESHOLD_MS ? "stuck" as const : "slow" as const);

	function formatDuration(ms: number): string {
		const s = Math.max(0, Math.round(ms / 1000));
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rem = s % 60;
		return rem === 0 ? `${m}m` : `${m}m${rem}s`;
	}

	let headline = $derived(
		severity === "stuck"
			? `This run has been silent for ${formatDuration(stalenessMs)} — it may be stuck.`
			: `This run has been silent for ${formatDuration(stalenessMs)}.`
	);
</script>

<div
	class="mx-4 mb-2 flex items-start gap-3 rounded-md border px-3 py-2 text-xs {severity ===
	'slow'
		? 'border-amber-500 bg-amber-500/10'
		: 'border-red-500 bg-red-500/10'}"
	role="status"
	aria-live="polite"
>
	<span class="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
		class:bg-amber-400={severity === "slow"}
		class:bg-red-400={severity === "stuck"}
		class:animate-pulse={severity === "stuck"}>
	</span>

	<div class="min-w-0 flex-1">
		<p class="font-medium text-[var(--color-text-primary)]">{headline}</p>
		<p class="mt-0.5 text-[var(--color-text-muted)]">
			Total elapsed: <span class="tabular-nums">{formatDuration(elapsedMs)}</span>
		</p>
	</div>

	<div class="flex shrink-0 items-center gap-2">
		<button
			type="button"
			onclick={onOpenObservability}
			class="rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-primary)] hover:bg-white/5"
		>
			View details
		</button>
		<button
			type="button"
			onclick={onCancel}
			class="rounded px-2 py-1 font-medium text-white {severity === 'slow'
				? 'bg-amber-600 hover:bg-amber-700'
				: 'bg-red-600 hover:bg-red-700'}"
		>
			Cancel
		</button>
	</div>
</div>
