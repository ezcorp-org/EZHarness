<!--
  ExtensionIframeCard — Phase A2 generic primitive.

  Renders a sandboxed iframe + slottable sidebar for any extension that
  wants a live-preview-style tool card. Replaces per-extension bespoke
  components going forward (claude-design's DesignCanvasCard composes
  this; ask-user will migrate to it in Phase C).

  Security model (load-bearing — do not relax without an audit):
    - `sandbox="allow-scripts allow-same-origin"` is HARD-CODED. The
      component does not accept a sandbox prop. Extensions that need
      escape-hatch flags (`allow-popups`, `allow-top-navigation`, etc.)
      should not use this primitive.
    - The iframe `src` is validated as a relative path or same-origin
      URL. Cross-origin URLs are refused — extensions serve content
      via /api/extensions/[name]/data/* on the host.
    - The `postEvent` snippet param POSTs to the generic events route,
      which itself enforces auth, conversation ownership, and the
      manifest event allowlist.

  Snippet API:

      <ExtensionIframeCard {toolCall} {conversationId}
                           iframeSrc="…" extensionName="…">
        {#snippet sidebar({ postEvent, busy })}
          <button onclick={() => postEvent("knob-change", { … })}>…</button>
        {/snippet}
      </ExtensionIframeCard>

  Events the extension can fire from the sidebar are bounded by what
  the extension declared in its manifest's permissions.eventSubscriptions
  — the host's generic route returns 404 for unknown events.

  Push-from-extension (canvas refresh / close) is NOT yet wired —
  see the Phase A header in @ezcorp/sdk/runtime/canvas.ts. Sidebars
  currently only emit OUTBOUND events; the iframe content is responsible
  for re-rendering itself or reloading via `iframeSrc` prop change.
-->

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { userFetch } from "$lib/utils/fetch-policy.js";
	import {
		SANDBOX_FLAGS_STRICT,
		buildEventUrl,
		isValidEventName,
		validateIframeSrc,
	} from "./iframe-card-logic.js";

	// ── Props ───────────────────────────────────────────────────────
	//
	// `iframeSrc` MUST be a relative path or same-origin URL. The
	// validation below refuses anything that parses as cross-origin or
	// uses a non-http(s) scheme.

	type SidebarParams = {
		/** Post a typed event to the host. Resolves on 2xx, rejects on
		 *  any other status with the response body's `error` field. */
		postEvent: (eventName: string, body: Record<string, unknown>) => Promise<void>;
		/** True while a postEvent call is in flight. Sidebars that
		 *  display knobs use this to disable inputs during dispatch. */
		busy: boolean;
	};

	let {
		toolCall,
		conversationId,
		iframeSrc,
		extensionName,
		sidebar,
		ariaLabel = "Extension preview",
	}: {
		toolCall: ToolCallState;
		/** The conversation this card lives in. Required for postEvent
		 *  to scope events correctly. Wrapper cards typically read this
		 *  from the active chat context (e.g. via the chat page's
		 *  conversation store) and pass it through. Kept as a prop
		 *  rather than derived from `toolCall` because `ToolCallState`
		 *  does not carry `conversationId` today. */
		conversationId: string;
		/** Relative path or same-origin URL. Cross-origin refused. */
		iframeSrc: string;
		/** Manifest name of the extension owning this card. Used to
		 *  build the events POST URL. */
		extensionName: string;
		/** Extension-specific controls. Receives a `postEvent` helper
		 *  and a `busy` flag. */
		sidebar?: Snippet<[SidebarParams]>;
		/** Accessibility label for the iframe. */
		ariaLabel?: string;
	} = $props();

	// ── Validation ──────────────────────────────────────────────────

	let validationError = $derived.by((): string | null => {
		const srcCheck = validateIframeSrc(iframeSrc, window.location.origin);
		if (!srcCheck.ok) return srcCheck.reason;
		if (!isValidEventName(extensionName)) {
			return "Invalid extension name";
		}
		return null;
	});

	// ── Event posting ───────────────────────────────────────────────

	let busy = $state(false);
	let lastError = $state<string | null>(null);

	async function postEvent(
		eventName: string,
		body: Record<string, unknown>,
	): Promise<void> {
		if (!isValidEventName(eventName)) {
			throw new Error(`[ExtensionIframeCard] invalid eventName: ${eventName}`);
		}
		const id = toolCall.id;
		if (!id) {
			throw new Error("[ExtensionIframeCard] toolCall.id missing — cannot post event");
		}
		if (!conversationId) {
			throw new Error(
				"[ExtensionIframeCard] conversationId missing — cannot post event",
			);
		}
		busy = true;
		lastError = null;
		try {
			const res = await userFetch(buildEventUrl(extensionName, eventName), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					toolCallId: id,
					conversationId,
					...body,
				}),
			});
			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? `HTTP ${res.status}`);
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			throw err;
		} finally {
			busy = false;
		}
	}

	// ── Iframe lifecycle ────────────────────────────────────────────

	let iframeLoaded = $state(false);
	let iframeError = $state<string | null>(null);

	function onIframeLoad(): void {
		iframeLoaded = true;
		iframeError = null;
	}

	function onIframeError(): void {
		iframeError = "Failed to load preview content";
	}

	// Re-key the iframe when src changes so the browser reloads cleanly
	// instead of caching the prior document. `iframeKey` increments on
	// every src change.
	let iframeKey = $state(0);
	let prevSrc = $state(iframeSrc);
	$effect(() => {
		if (iframeSrc !== prevSrc) {
			iframeKey++;
			iframeLoaded = false;
			iframeError = null;
			prevSrc = iframeSrc;
		}
	});
</script>

<div class="extension-iframe-card" data-tool-call-id={toolCall.id}>
	{#if validationError}
		<div class="error-state" role="alert">
			<strong>Cannot render preview:</strong>
			{validationError}
		</div>
	{:else if toolCall.status === "error"}
		<div class="error-state" role="alert">
			<strong>Tool error:</strong>
			{toolCall.error ?? "Unknown error"}
		</div>
	{:else}
		<div class="preview-container">
			<div class="iframe-wrap">
				{#if !iframeLoaded && !iframeError}
					<div class="loading-overlay" aria-live="polite">Loading preview…</div>
				{/if}
				{#if iframeError}
					<div class="error-overlay" role="alert">{iframeError}</div>
				{/if}
				{#key iframeKey}
					<iframe
						title={ariaLabel}
						aria-label={ariaLabel}
						src={iframeSrc}
						sandbox={SANDBOX_FLAGS_STRICT}
						onload={onIframeLoad}
						onerror={onIframeError}
					></iframe>
				{/key}
			</div>
			{#if sidebar}
				<aside class="sidebar" aria-label="Preview controls">
					{@render sidebar({ postEvent, busy })}
					{#if lastError}
						<div class="event-error" role="alert">{lastError}</div>
					{/if}
				</aside>
			{/if}
		</div>
	{/if}
</div>

<style>
	.extension-iframe-card {
		display: block;
		width: 100%;
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 6px;
		overflow: hidden;
		background: var(--color-surface, #1a1a1a);
	}

	.preview-container {
		display: grid;
		grid-template-columns: 1fr auto;
		min-height: 320px;
	}

	.iframe-wrap {
		position: relative;
		min-height: 320px;
		background: var(--color-bg, #0d0d0d);
	}

	.iframe-wrap iframe {
		width: 100%;
		height: 100%;
		min-height: 320px;
		border: 0;
		display: block;
	}

	.loading-overlay,
	.error-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg, #0d0d0d);
		color: var(--color-text-muted, #a0a0a0);
		font-size: 0.875rem;
		pointer-events: none;
	}

	.error-overlay {
		color: var(--color-error, #ef4444);
	}

	.sidebar {
		min-width: 240px;
		max-width: 320px;
		padding: 0.75rem;
		border-left: 1px solid var(--color-border, #2a2a2a);
		background: var(--color-surface-2, #141414);
		overflow-y: auto;
	}

	.event-error {
		margin-top: 0.5rem;
		padding: 0.5rem;
		border-radius: 4px;
		background: rgba(239, 68, 68, 0.1);
		color: var(--color-error, #ef4444);
		font-size: 0.8125rem;
	}

	.error-state {
		padding: 1rem;
		color: var(--color-error, #ef4444);
		font-size: 0.875rem;
	}

	@media (max-width: 640px) {
		.preview-container {
			grid-template-columns: 1fr;
		}
		.sidebar {
			max-width: none;
			border-left: 0;
			border-top: 1px solid var(--color-border, #2a2a2a);
		}
	}
</style>
