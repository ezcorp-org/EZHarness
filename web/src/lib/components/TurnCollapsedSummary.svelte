<script lang="ts">
	/**
	 * The one row a collapsed turn leaves behind, under the user's prompt:
	 * "12 replies · 3 tools" with a chevron. Clicking it unfolds the turn.
	 *
	 * Deliberately the same shape as `ThinkingCard`'s collapsed header — same
	 * muted text, same chevron, same `aria-expanded` on a plain button — so a
	 * folded turn reads like every other folded thing in the thread.
	 */
	import { slide } from "svelte/transition";

	interface Props {
		replies: number;
		tools: number;
		onexpand: () => void;
	}

	let { replies, tools, onexpand }: Props = $props();

	// "12 replies · 3 tools" — the tool half is dropped when there are none, so
	// a plain answer does not read as "· 0 tools".
	let label = $derived(
		[
			`${replies} ${replies === 1 ? "reply" : "replies"}`,
			...(tools > 0 ? [`${tools} ${tools === 1 ? "tool" : "tools"}`] : []),
		].join(" · "),
	);
</script>

<div class="px-4 pb-3" transition:slide={{ duration: 150 }}>
	<div class="mx-auto max-w-3xl">
		<button
			type="button"
			onclick={onexpand}
			data-testid="turn-collapsed-summary"
			aria-expanded="false"
			aria-label="Expand turn — {label}"
			class="flex w-full items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-surface-secondary)]/50"
		>
			<svg
				class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="1.5"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M8.25 6.75 12 3m0 0 3.75 3.75M12 3v18m0 0-3.75-3.75M12 21l3.75-3.75"
				/>
			</svg>
			<span class="text-[var(--color-text-muted)]">{label}</span>
			<svg
				class="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</button>
	</div>
</div>
