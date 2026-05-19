<script lang="ts">
	import { lightbox } from "$lib/image-lightbox.svelte.js";

	function handleKey(e: KeyboardEvent) {
		if (e.key === "Escape" && lightbox.open) {
			e.preventDefault();
			lightbox.hide();
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) lightbox.hide();
	}
</script>

<svelte:window onkeydown={handleKey} />

{#if lightbox.open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="lightbox-backdrop"
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
		aria-label={lightbox.alt || "Image preview"}
		data-testid="image-lightbox"
		tabindex={-1}
	>
		<button
			type="button"
			class="lightbox-close"
			aria-label="Close image preview"
			onclick={() => lightbox.hide()}
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>
		<img class="lightbox-img" src={lightbox.src} alt={lightbox.alt} />
	</div>
{/if}

<style>
	.lightbox-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		background: rgba(0, 0, 0, 0.85);
		backdrop-filter: blur(4px);
		cursor: zoom-out;
	}
	.lightbox-img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		border-radius: 0.5rem;
		box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
		cursor: default;
	}
	.lightbox-close {
		position: fixed;
		top: 1rem;
		right: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
		border: none;
		background: rgba(255, 255, 255, 0.1);
		color: white;
		cursor: pointer;
		transition: background 0.15s;
	}
	.lightbox-close:hover {
		background: rgba(255, 255, 255, 0.2);
	}
	.lightbox-close:focus-visible {
		outline: 2px solid white;
		outline-offset: 2px;
	}
</style>
