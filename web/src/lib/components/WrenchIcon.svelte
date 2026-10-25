<script lang="ts">
	/**
	 * The one tools glyph of the UI: lucide's Wrench path, drawn like the composer chips' other icons (stroke
	 * currentColor, stroke-width 2, 24 viewBox, aria-hidden). It replaces the U+1F527 wrench emoji, which needs an emoji font
	 * and renders as an empty box without one. The default class is the Model chip icon's; pass `h-3 w-3` alone to
	 * take the surrounding text color (and its hover color).
	 */
	let { class: className = "h-3 w-3 text-[var(--color-text-muted)]" }: { class?: string } = $props();
</script>

<svg class={className} fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true" data-icon="wrench">
	<path stroke-linecap="round" stroke-linejoin="round" d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
</svg>
