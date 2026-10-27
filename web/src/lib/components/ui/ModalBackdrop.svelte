<!--
  ModalBackdrop: the one full-viewport layer behind a modal, sheet, drawer or popover.

  It is a `fixed inset-0` box with an explicit `m-0`. The backdrops render where their component sits, and inside a
  `space-y-*` stack Tailwind's spacing used to give them a bottom margin: with `inset: 0` that shrank the layer, and
  the status bar strip stayed bright and clickable under an open modal. `m-0` outranks the zero-specificity
  `:where()` spacing selectors, so no parent layout can move an edge.

  `src/__tests__/modal-backdrop-guard.test.ts` fails on a raw `fixed inset-0` box, or a scoped `position: fixed` rule
  pinned to all four edges, anywhere else.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		z = 50,
		dim = 0,
		variant,
		onclose,
		element = $bindable(),
		class: className = "",
		children,
		...rest
	}: Omit<HTMLAttributes<HTMLDivElement>, "onclick"> & {
		/** Stacking order: 40 for a popover's click-catcher, 50 for a modal; a drawer passes its own. */
		z?: number;
		/** The black wash behind the content, in percent: none, 50 or 60. */
		dim?: 0 | 50 | 60;
		/**
		 * A shared look that more than one surface uses. `lightbox`: the near-black blurred wash of the image previews,
		 * centred, zoom-out cursor. `console`: the factory consoles' ink wash, a scrolling grid that holds its dialog at
		 * the top centre (the site sets the padding).
		 */
		variant?: "lightbox" | "console";
		/** Called when a click lands on the backdrop itself, not on the content inside it. */
		onclose?: () => void;
		element?: HTMLElement | null;
		/** Layout of the content inside the layer (centering, padding). */
		class?: string;
		children?: Snippet;
	} = $props();

	const DIM_CLASS = { 0: "", 50: "bg-black/50", 60: "bg-black/60" } as const;
	const VARIANT_CLASS = {
		lightbox: "flex items-center justify-center p-8 bg-[rgb(0_0_0/0.85)] backdrop-blur-[4px] cursor-zoom-out",
		console: "grid items-start justify-items-center overflow-auto bg-[rgb(4_8_18/0.72)]",
	} as const;

	function handleClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onclose?.();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={element}
	class="fixed inset-0 m-0 {DIM_CLASS[dim]} {variant ? VARIANT_CLASS[variant] : ''} {className}"
	style:z-index={z}
	onclick={handleClick}
	{...rest}
>
	{@render children?.()}
</div>
