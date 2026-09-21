<script lang="ts">
	import { shouldShowUnsandboxedBanner } from "./UnsandboxedExtensionsBanner.helpers";

	// The mode string from `/api/auth/me` (`extensionRunner`), fetched once by
	// the app shell. No dismiss control on purpose: this is a standing fact
	// about the host, not a notification, and it should be as persistent as
	// the risk it names.
	//
	// Which is why it is a STICKY STRIP inside `<main>` rather than a floating
	// card: every corner of the overlay layer is already claimed, and the
	// bottom-right one is claimed by `PendingDecisionsTray` — "the one
	// bottom-right stack for decisions the user has to make" — at the very
	// same `bottom-4 right-4` / `z-60`, 28rem wide against this banner's 22rem
	// and painted after it in the layout. A standing warning that vanishes
	// entirely the moment the user is asked to approve something is worse than
	// no warning at all, and `toBeVisible()` cannot see the occlusion.
	//
	// In flow it cannot cover anything or be covered: `<main>` is the scroll
	// container, so `sticky top: 0` pins the strip while content scrolls under
	// it, and main's `padding-right` already reserves the dock's width.
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
		/* Sticky, not fixed: pinned to the top of `<main>`'s scroll box, so it
		   stays on screen without ever entering the overlay layer. z-index is
		   deliberately below the dock (50) and the toast/tray stack (60) —
		   those are foreground surfaces the user just summoned, and they sit
		   elsewhere on the screen anyway. */
		position: sticky;
		top: 0;
		z-index: 30;
		display: flex;
		/* flex-start, not centre: when the strip wraps to several lines on a
		   narrow column the icon and the Review link must stay level with the
		   headline, not drift to the middle of the block. */
		align-items: flex-start;
		gap: 0.5rem 0.625rem;
		padding: 0.5rem calc(0.875rem + env(safe-area-inset-right, 0px)) 0.5rem calc(0.875rem + env(safe-area-inset-left, 0px));
		background: #5f3a1f;
		color: #fff;
		border-bottom: 1px solid rgba(255, 255, 255, 0.18);
		font-size: 0.8125rem;
		line-height: 1.35;
	}
	.icon {
		flex: 0 0 auto;
		width: 1.125rem;
		height: 1.125rem;
	}
	.body {
		/* Headline and detail read as one sentence on a wide strip and wrap to
		   two lines on a narrow one — no breakpoint needed. */
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.375rem;
	}
	.headline {
		font-weight: 600;
	}
	.detail {
		opacity: 0.9;
	}
	.review-link {
		flex: 0 0 auto;
		color: #fff;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
