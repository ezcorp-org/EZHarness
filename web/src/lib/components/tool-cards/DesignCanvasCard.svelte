<!--
  DesignCanvasCard — claude-design's UI consumer of ExtensionIframeCard.
  First real composition of the Phase A primitive; doubles as the
  reference implementation for any future canvas-style extension.

  Reads the iframeSrc + knob options from the open-canvas tool's
  output, renders the iframe, and slots in a knob panel along the
  edge that POSTs `claude-design:knob-change` events through the
  generic /api/extensions/[name]/events/[event] route.
-->

<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import ExtensionIframeCard from "./ExtensionIframeCard.svelte";

	let {
		toolCall,
		conversationId = "",
		mode = "inline",
	}: {
		toolCall: ToolCallState;
		conversationId?: string;
		/** "inline" — chat bubble. "dock" — full-bleed in DockHost panel.
		 *  In dock mode the wrapping ExtensionIframeCard relaxes its
		 *  min-height + drops border so the iframe fills the host. */
		mode?: "inline" | "dock";
	} = $props();

	// ── Parse the tool result to find iframeSrc + draft id ──────────

	type ToolPayload = {
		draftId?: string;
		iframeSrc?: string;
	};

	let payload = $derived.by((): ToolPayload => {
		const out = toolCall.output;
		if (out == null) return {};
		// The chat store's `extractToolOutput` flattens
		// `{ content: [{ type: "text", text: "<json>" }] }` to the inner
		// text string before reaching us, so the live path arrives as a
		// string. The history-hydration path may still deliver the full
		// envelope. Accept both, plus the already-parsed object form for
		// future call sites.
		if (typeof out === "string") {
			try {
				return JSON.parse(out) as ToolPayload;
			} catch {
				return {};
			}
		}
		if (typeof out !== "object") return {};
		if ("content" in out && Array.isArray((out as { content: unknown[] }).content)) {
			const text = (out as { content: Array<{ type?: string; text?: unknown }> }).content
				.find((c) => c.type === "text")?.text;
			if (typeof text === "string") {
				try {
					return JSON.parse(text) as ToolPayload;
				} catch {
					return {};
				}
			}
		}
		// Already-parsed object with the right shape.
		const o = out as ToolPayload;
		if (typeof o.iframeSrc === "string" || typeof o.draftId === "string") {
			return o;
		}
		return {};
	});

	let draftId = $derived(payload.draftId ?? "");
	let baseIframeSrc = $derived(payload.iframeSrc ?? "");

	// Cache-busted iframe URL. Knob changes write a new revision back to
	// the parent draft's HTML file (see `applyKnobsToDraft` in the
	// extension's index.ts), so the iframe URL is stable but the content
	// at that URL changes. Without a query-param bump, the browser caches
	// the pre-tweak HTML and the user sees no change. We bump on every
	// successful `postEvent("knob-change")` and also on iframeSrc changes.
	let iframeBustTick = $state(0);
	let iframeSrc = $derived.by((): string => {
		if (!baseIframeSrc) return "";
		if (iframeBustTick === 0) return baseIframeSrc;
		const sep = baseIframeSrc.includes("?") ? "&" : "?";
		return `${baseIframeSrc}${sep}_v=${iframeBustTick}`;
	});

	// conversationId is threaded through ToolCardRouter — it's the
	// active conversation the chat page is rendering.

	// ── Local knob state (sliders / swatches) ───────────────────────
	// Mirrors the open-canvas tool's `knobsAvailable` advertisement —
	// every key returned there must have a matching input here, otherwise
	// the API contract and the UI disagree. [I5 from the Phase B review]

	let primaryColor = $state("");
	let secondaryColor = $state("");
	let spacingScale = $state(0); // delta percent: -25..+50
	let borderRadius = $state(""); // px or empty
	let density = $state<"" | "compact" | "cozy" | "spacious">("");

	let lastKnobError = $state<string | null>(null);
</script>

{#if !draftId || !iframeSrc}
	<div class="missing-payload" role="alert">
		<strong>Cannot render canvas:</strong> open-canvas did not return draftId/iframeSrc
		fields.
	</div>
{:else if !conversationId}
	<div class="missing-payload" role="alert">
		<strong>Cannot render canvas:</strong> conversationId is not threaded through
		this tool call yet (Phase B follow-up).
	</div>
{:else}
	<ExtensionIframeCard
		{toolCall}
		{conversationId}
		{iframeSrc}
		{mode}
		extensionName="claude-design"
		ariaLabel="Design canvas"
	>
		{#snippet sidebar({ postEvent, busy })}
			<header class="sidebar-header">Design knobs</header>

			<label class="knob">
				<span>Primary color</span>
				<input
					type="color"
					bind:value={primaryColor}
					disabled={busy}
				/>
			</label>

			<label class="knob">
				<span>Secondary color</span>
				<input
					type="color"
					bind:value={secondaryColor}
					disabled={busy}
				/>
			</label>

			<label class="knob">
				<span>Spacing ({spacingScale > 0 ? "+" : ""}{spacingScale}%)</span>
				<input
					type="range"
					min="-25"
					max="50"
					step="5"
					bind:value={spacingScale}
					disabled={busy}
				/>
			</label>

			<label class="knob">
				<span>Border radius (px)</span>
				<input
					type="text"
					placeholder="e.g. 0, 4, 8"
					bind:value={borderRadius}
					disabled={busy}
				/>
			</label>

			<label class="knob">
				<span>Density</span>
				<select bind:value={density} disabled={busy}>
					<option value="">— no override —</option>
					<option value="compact">Compact</option>
					<option value="cozy">Cozy</option>
					<option value="spacious">Spacious</option>
				</select>
			</label>

			<button
				type="button"
				class="apply"
				disabled={busy}
				onclick={async () => {
					const knobs: Record<string, string> = {};
					if (primaryColor) knobs.primaryColor = primaryColor;
					if (secondaryColor) knobs.secondaryColor = secondaryColor;
					if (spacingScale !== 0) {
						knobs.spacingScale = (spacingScale > 0 ? "+" : "") + spacingScale + "%";
					}
					if (borderRadius) knobs.borderRadius = borderRadius;
					if (density) knobs.density = density;
					if (Object.keys(knobs).length === 0) return;
					try {
						await postEvent("knob-change", { draftId, knobs });
						lastKnobError = null;
						// The route's POST returns as soon as the bus event is
						// queued. The subprocess's handler (which runs the actual
						// CSS-var rewrite + file write) executes asynchronously
						// after that. 600ms is comfortably above observed handler
						// turnaround on small drafts and below human-perceptible
						// lag. Bumping the tick changes the iframe URL (cache-bust
						// query param), which the ExtensionIframeCard's existing
						// `iframeKey` effect notices and triggers a clean reload.
						setTimeout(() => { iframeBustTick = Date.now(); }, 600);
					} catch (err) {
						lastKnobError = err instanceof Error ? err.message : String(err);
					}
				}}
			>
				{busy ? "Applying…" : "Apply knobs"}
			</button>

			{#if lastKnobError}
				<div class="knob-error" role="alert">{lastKnobError}</div>
			{/if}
		{/snippet}
	</ExtensionIframeCard>
{/if}

<style>
	.missing-payload {
		padding: 1rem;
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 6px;
		background: var(--color-surface, #1a1a1a);
		color: var(--color-error, #ef4444);
		font-size: 0.875rem;
	}

	.sidebar-header {
		font-weight: 600;
		font-size: 0.875rem;
		margin-bottom: 0.5rem;
		color: var(--color-text, #e0e0e0);
	}

	.knob {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #a0a0a0);
	}

	.knob input[type="color"],
	.knob input[type="text"],
	.knob input[type="range"] {
		width: 100%;
	}

	.apply {
		width: 100%;
		padding: 0.5rem;
		background: var(--color-primary, #4a72ff);
		color: #fff;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.apply:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.knob-error {
		margin-top: 0.5rem;
		padding: 0.5rem;
		border-radius: 4px;
		background: rgba(239, 68, 68, 0.1);
		color: var(--color-error, #ef4444);
		font-size: 0.8125rem;
	}
</style>
