<script lang="ts">
	import { shouldShowUnsandboxedBanner } from "./UnsandboxedExtensionsBanner.helpers";

	// The mode string from `/api/auth/me` (`extensionRunner`), fetched once by
	// the app shell. No dismiss control on purpose: this is a standing fact
	// about the host, not a notification, and it should be as persistent as
	// the risk it names.
	let { mode }: { mode: string | null } = $props();
</script>

{#if shouldShowUnsandboxedBanner(mode)}
	<div class="unsandboxed-banner" role="alert" data-testid="unsandboxed-extensions-banner">
		<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
		</svg>
		<div class="body">
			<div class="headline">Extensions are not sandboxed on this host.</div>
			<div class="detail">They run with the app's full powers. Each build and each release needs your explicit acknowledgement.</div>
		</div>
		<a class="review-link" href="/extensions/author">Review</a>
	</div>
{/if}

<style>
	.unsandboxed-banner {
		position: fixed;
		bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		right: calc(1rem + env(safe-area-inset-right, 0px));
		z-index: 60;
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		max-width: min(22rem, calc(100vw - 2rem));
		padding: 0.75rem 0.875rem;
		background: #5f3a1f;
		color: #fff;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 0.5rem;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
		font-size: 0.8125rem;
		line-height: 1.35;
	}
	.icon {
		flex: 0 0 auto;
		width: 1.125rem;
		height: 1.125rem;
		margin-top: 0.05rem;
	}
	.body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.headline {
		font-weight: 600;
	}
	.detail {
		margin-top: 0.15rem;
		opacity: 0.9;
	}
	.review-link {
		flex: 0 0 auto;
		align-self: center;
		color: #fff;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
