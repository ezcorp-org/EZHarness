<script lang="ts">
	import SharedFilePicker from "./ui/SharedFilePicker.svelte";
	import BottomSheet from "$lib/components/BottomSheet.svelte";
	import { useBreakpoint } from "$lib/use-breakpoint.svelte";

	let {
		value = $bindable(""),
		placeholder = "Enter file path...",
	}: { value: string; placeholder?: string } = $props();

	// Phase 57 UX-01 Wave 2: wrap picker body in BottomSheet on <lg.
	// FilePicker is a 10-line shim around SharedFilePicker (Pitfall 8 —
	// wrap MUST happen here, NOT inside SharedFilePicker, so other call
	// sites — FeatureIndex.svelte, ChatInput mention popover — don't
	// accidentally render bottom-sheets). SharedFilePicker manages its
	// own internal `open` state (focus/content-driven autocomplete), so
	// the wrap surfaces an external `open` flag that the shim flips
	// when its input receives focus on mobile.
	const bp = useBreakpoint("lg");
	let mobileOpen = $state(false);

	function openMobile() {
		mobileOpen = true;
	}
	function closeMobile() {
		mobileOpen = false;
	}
</script>

{#if bp.below}
	<!-- Mobile / <lg: render a trigger that opens the picker inside a
	     BottomSheet. The trigger displays the current value (or
	     placeholder) and is the user's tap target — matches the
	     bottom-sheet picker UX of the other 8 pickers. -->
	<button
		type="button"
		data-testid="open-file-picker"
		onclick={openMobile}
		class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-left text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-secondary)]"
		style="min-height: 36px;"
	>
		{value || placeholder}
	</button>
	{#if mobileOpen}
		<BottomSheet open={true} onclose={closeMobile} ariaLabel="File picker">
			<div class="p-3">
				<SharedFilePicker bind:value {placeholder} size="sm" />
			</div>
		</BottomSheet>
	{/if}
{:else}
	<!-- Desktop / >=lg: shim behaves byte-identically to the pre-Wave 2
	     contract — direct SharedFilePicker delegation. -->
	<span data-testid="open-file-picker" style="display:contents;">
		<SharedFilePicker bind:value {placeholder} size="sm" />
	</span>
{/if}
