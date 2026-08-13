<script lang="ts">
	import type { ToolCallState } from '$lib/stores.svelte.js';
	import { formatClockDate, getClockParts, parseTimeClockPayload } from './time-clock-logic.js';

	let { toolCall }: { toolCall: ToolCallState } = $props();

	let nowMs = $state(Date.now());
	const gradientId = `timeClockGlow-${Math.random().toString(36).slice(2)}`;

	$effect(() => {
		const timer = window.setInterval(() => {
			nowMs = Date.now();
		}, 1000);
		return () => window.clearInterval(timer);
	});

	let payload = $derived(parseTimeClockPayload(toolCall.output));
	let now = $derived(new Date(nowMs));
	let parts = $derived(payload ? getClockParts(now, payload.locale, payload.timezone) : null);
	let display = $derived(payload ? formatClockDate(now, payload) : '');
	let digitalTime = $derived(display.split(' at ').at(-1) ?? display);
	let dateLabel = $derived(display.includes(' at ') ? display.split(' at ')[0] : payload?.formatted ?? '');
</script>

{#if !payload || !parts}
	<div class="time-clock-error" role="alert" data-testid="time-clock-missing">
		<strong>Cannot render clock:</strong> tool output is missing required time fields.
	</div>
{:else}
	<div class="time-clock-card" data-testid="time-clock-card" aria-label={display}>
		<div class="clock-face-wrap" aria-hidden="true">
			<svg class="clock-face" viewBox="0 0 120 120" role="img">
				<defs>
					<radialGradient id={gradientId} cx="50%" cy="45%" r="65%">
						<stop offset="0%" stop-color="rgba(255,255,255,0.20)" />
						<stop offset="72%" stop-color="rgba(99,102,241,0.10)" />
						<stop offset="100%" stop-color="rgba(14,165,233,0.12)" />
					</radialGradient>
				</defs>
				<circle cx="60" cy="60" r="55" class="clock-outer" fill={`url(#${gradientId})`} />
				<circle cx="60" cy="60" r="49" class="clock-inner" />
				{#each Array.from({ length: 12 }) as _, index}
					<line
						x1="60"
						y1="10"
						x2="60"
						y2={index % 3 === 0 ? '18' : '15'}
						class:index-tick={index % 3 === 0}
						class="tick"
						transform={`rotate(${index * 30} 60 60)`}
					/>
				{/each}
				<line class="hand hour-hand" x1="60" y1="60" x2="60" y2="34" transform={`rotate(${parts.hourAngle} 60 60)`} />
				<line class="hand minute-hand" x1="60" y1="60" x2="60" y2="23" transform={`rotate(${parts.minuteAngle} 60 60)`} />
				<line class="hand second-hand" x1="60" y1="66" x2="60" y2="18" transform={`rotate(${parts.secondAngle} 60 60)`} />
				<circle cx="60" cy="60" r="4.6" class="pin" />
			</svg>
		</div>

		<div class="clock-copy">
			<div class="eyebrow">{payload.label}</div>
			<div class="digital" data-testid="time-clock-digital">{digitalTime}</div>
			<div class="date-label">{dateLabel}</div>
			<div class="meta-row">
				<span>{payload.timezone}</span>
				<span>{payload.locale}</span>
			</div>
			<div class="iso">{payload.iso}</div>
		</div>
	</div>
{/if}

<style>
	.time-clock-card {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, var(--color-border, #2a2a2a) 78%, transparent);
		border-radius: 1rem;
		background:
			radial-gradient(circle at 18% 18%, rgba(14, 165, 233, 0.18), transparent 34%),
			linear-gradient(135deg, var(--color-surface, #18181b), var(--color-surface-tertiary, #101014));
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05);
		max-width: 34rem;
	}

	.clock-face-wrap {
		position: relative;
		width: 8rem;
		height: 8rem;
		flex: 0 0 auto;
		filter: drop-shadow(0 12px 24px rgba(14, 165, 233, 0.16));
	}

	.clock-face {
		width: 100%;
		height: 100%;
	}

	.clock-outer {
		stroke: rgba(255, 255, 255, 0.22);
		stroke-width: 1.5;
	}

	.clock-inner {
		fill: rgba(0, 0, 0, 0.10);
		stroke: rgba(255, 255, 255, 0.08);
		stroke-width: 1;
	}

	.tick {
		stroke: rgba(255, 255, 255, 0.50);
		stroke-width: 1.4;
		stroke-linecap: round;
	}

	.index-tick {
		stroke: rgba(255, 255, 255, 0.78);
		stroke-width: 2.2;
	}

	.hand {
		stroke-linecap: round;
		transform-origin: 60px 60px;
	}

	.hour-hand {
		stroke: rgba(255, 255, 255, 0.88);
		stroke-width: 5;
	}

	.minute-hand {
		stroke: rgba(226, 232, 240, 0.90);
		stroke-width: 3.4;
	}

	.second-hand {
		stroke: var(--color-accent, #38bdf8);
		stroke-width: 1.8;
	}

	.pin {
		fill: var(--color-accent, #38bdf8);
		stroke: rgba(255, 255, 255, 0.9);
		stroke-width: 1.2;
	}

	.clock-copy {
		min-width: 0;
	}

	.eyebrow {
		margin-bottom: 0.2rem;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-accent, #38bdf8);
	}

	.digital {
		font-variant-numeric: tabular-nums;
		font-size: clamp(1.8rem, 4vw, 2.75rem);
		font-weight: 750;
		line-height: 1.05;
		color: var(--color-text, #f8fafc);
	}

	.date-label {
		margin-top: 0.35rem;
		color: var(--color-text-secondary, #cbd5e1);
		font-size: 0.92rem;
	}

	.meta-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.65rem;
	}

	.meta-row span {
		border: 1px solid rgba(255, 255, 255, 0.10);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.055);
		padding: 0.18rem 0.55rem;
		font-size: 0.72rem;
		color: var(--color-text-secondary, #cbd5e1);
	}

	.iso {
		margin-top: 0.5rem;
		font-size: 0.7rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		color: var(--color-text-muted, #94a3b8);
		word-break: break-all;
	}

	.time-clock-error {
		padding: 0.75rem 1rem;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 8px;
		color: var(--color-error, #ef4444);
		font-size: 0.875rem;
	}

	@media (max-width: 520px) {
		.time-clock-card {
			align-items: flex-start;
			gap: 0.75rem;
			padding: 0.85rem;
		}

		.clock-face-wrap {
			width: 5.75rem;
			height: 5.75rem;
		}
	}
</style>
