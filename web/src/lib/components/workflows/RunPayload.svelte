<script lang="ts">
	/**
	 * One labelled payload from a workflow run — a run's final output, a
	 * step's output, a step's resolved input.
	 *
	 * All three read the same four states off `payloadView`, and the run
	 * trace used to render them inline, per pane. Two more call sites
	 * landing on that markup is what this component avoids: the
	 * "not recorded" wording, the truncation notice and the prose-vs-JSON
	 * split are one decision each, not one per surface.
	 *
	 * **"not recorded" is never "empty".** A payload the executor did not
	 * store and a payload that really is an empty string are different
	 * facts, and the whole trace surface is built on not collapsing a gap
	 * into a measurement — so each gets its own line.
	 */
	import { formatTokens, payloadView } from "$lib/workflow-trace-logic.js";

	let {
		label,
		value,
		testId,
	}: {
		label: string;
		value: unknown;
		/** Applied to the CONTENT element, so a caller asserts on the payload
		 *  rather than on the wrapper that holds the heading too. */
		testId: string;
	} = $props();

	let view = $derived(payloadView(value));
</script>

<div data-testid="{testId}-pane">
	<p class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
	{#if view.kind === "absent"}
		<p class="text-xs text-[var(--color-text-muted)]" data-testid={testId}>not recorded</p>
	{:else if view.kind === "truncated"}
		<p class="text-xs text-amber-400" data-testid={testId}>
			Too large to store ({formatTokens(view.bytes)} bytes) — kept as a marker so nothing here
			pretends to be the real value.
		</p>
	{:else if view.text === ""}
		<p class="text-xs italic text-[var(--color-text-muted)]" data-testid={testId}>
			empty (the run recorded an empty string)
		</p>
	{:else}
		<!-- Bordered, not just tinted. The surface tint alone vanishes on any
		     parent that shares it — the run trace's Result card does — and the
		     payload then reads as loose text rather than as a block.

		     Prose wraps; JSON does not: its indentation IS the structure, and
		     re-flowing it destroys the alignment a reader scans down. -->
		<pre
			class="mt-1 max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-text-secondary)] {view.kind ===
			'text'
				? 'whitespace-pre-wrap break-words'
				: ''}"
			data-testid={testId}>{view.text}</pre>
	{/if}
</div>
