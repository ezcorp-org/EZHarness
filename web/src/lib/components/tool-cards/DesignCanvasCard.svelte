<!--
  DesignCanvasCard — claude-design's UI consumer of ExtensionIframeCard.
  First real composition of the Phase A primitive; doubles as the
  reference implementation for any future canvas-style extension.

  Reads the iframeSrc + knob options from the open-canvas tool's
  output, renders the iframe, and slots in a knob panel along the
  edge that invokes the `tweak-design` tool inline (via
  `invokeInlineTool`) so the apply round-trip surfaces a typed
  result we can render as a banner / dirty-dot / diff drawer.

  Backwards-compat: every new field on the tweak-design / open-canvas
  payload (knobValues, originalTokensBlock, tokensBlock, revisions) is
  optional. Legacy drafts that predate them keep rendering with the
  original UI — banner is hidden, no dirty dots, no diff drawer, no
  dropdown.
-->

<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import ExtensionIframeCard from "./ExtensionIframeCard.svelte";
	import {
		buildKnobBody as buildKnobBodyPure,
		encodeKnobValue,
		type KnobBodyDescriptor,
	} from "./design-canvas-knob-logic";
	import {
		summarizeChangedVars,
		isKnobDirty,
		formatRevisionLabel,
		buildTokensDiffText,
		type Revision,
	} from "./apply-banner-logic";
	import { invokeInlineTool } from "$lib/invoke-inline-tool";
	import { inlineToolStore } from "$lib/inline-tool-store.svelte";
	import * as Diff2Html from "diff2html";
	import { highlightDiff } from "$lib/highlight-diff";

	let {
		toolCall,
		conversationId = "",
		messageId,
		mode = "inline",
	}: {
		toolCall: ToolCallState;
		conversationId?: string;
		messageId?: string;
		/** "inline" — chat bubble. "dock" — full-bleed in DockHost panel.
		 *  In dock mode the wrapping ExtensionIframeCard relaxes its
		 *  min-height + drops border so the iframe fills the host. */
		mode?: "inline" | "dock";
	} = $props();

	// ── Parse the tool result to find iframeSrc + draft id ──────────

	type KnobDescriptor = {
		key: string;
		label: string;
		kind: "color" | "range" | "select" | "text";
		var?: string;
		behavior?: "scale-spacing";
		options?: string[];
		min?: number;
		max?: number;
		step?: number;
		unit?: "px" | "rem" | "em" | "%" | "";
		current?: string;
	};

	type ToolPayload = {
		draftId?: string;
		iframeSrc?: string;
		knobs?: KnobDescriptor[];
		knobsTitle?: string;
		// New fields (optional — legacy drafts omit them).
		knobValues?: Record<string, string>;
		originalTokensBlock?: string;
		tokensBlock?: string;
		revisions?: Revision[];
		changedVars?: string[];
	};

	// Descriptor form of the original five hardcoded knobs. Used as a
	// fallback when `payload.knobs` is missing/empty so legacy drafts
	// (created before descriptors were threaded through) keep working.
	const LEGACY_DESCRIPTORS: KnobDescriptor[] = [
		{ key: "primaryColor", label: "Primary color", kind: "color", var: "--color-primary" },
		{ key: "secondaryColor", label: "Secondary color", kind: "color", var: "--color-secondary" },
		{
			key: "spacingScale",
			label: "Spacing scale (%)",
			kind: "range",
			behavior: "scale-spacing",
			min: -25,
			max: 50,
			step: 5,
			unit: "%",
		},
		{
			key: "borderRadius",
			label: "Border radius",
			kind: "range",
			var: "--radius-base",
			min: 0,
			max: 24,
			step: 2,
			unit: "px",
		},
		{
			key: "density",
			label: "Density",
			kind: "select",
			options: ["compact", "cozy", "spacious"],
			behavior: "scale-spacing",
		},
	];

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
	// the pre-tweak HTML and the user sees no change.
	let iframeBustTick = $state(0);
	let iframeSrc = $derived.by((): string => {
		if (!baseIframeSrc) return "";
		if (iframeBustTick === 0) return baseIframeSrc;
		const sep = baseIframeSrc.includes("?") ? "&" : "?";
		return `${baseIframeSrc}${sep}_v=${iframeBustTick}`;
	});

	// ── Adaptive knob state (descriptor-driven) ─────────────────────

	let values = $state<Record<string, string>>({});
	let knobs = $derived<KnobDescriptor[]>(
		payload.knobs && payload.knobs.length > 0 ? payload.knobs : LEGACY_DESCRIPTORS,
	);
	let knobsTitle = $derived(payload.knobsTitle ?? "Design knobs");

	// ── tweak-design apply state ────────────────────────────────────
	//
	// Apply now invokes `tweak-design` via invokeInlineTool. We track
	// the latest invocationId locally and read its status from
	// inlineToolStore on every render.

	let lastInvocationId = $state<string | null>(null);
	// Seed via the $effect below from `payload` (a $derived) so we don't
	// snapshot the initial value of a derived in $state initializers.
	let liveAppliedValues = $state<Record<string, string>>({});
	let liveTokensBlock = $state<string | undefined>(undefined);
	let liveRevisions = $state<Revision[]>([]);
	let bannerVisible = $state(false);
	let bannerKind = $state<"success" | "error">("success");
	let bannerText = $state<string>("");
	let bannerError = $state<string>("");
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	// When the tool output arrives (history hydration / first render),
	// seed the live state. This effect runs whenever the parsed payload
	// changes — typically once on mount.
	$effect(() => {
		if (payload.knobValues) liveAppliedValues = payload.knobValues;
		if (payload.tokensBlock !== undefined) liveTokensBlock = payload.tokensBlock;
		if (payload.revisions) liveRevisions = payload.revisions;
	});

	// Track which (invocationId, status) pairs we've already processed so
	// the effect doesn't re-fire on its own state writes (which would
	// either auto-dismiss instantly or loop forever).
	let lastProcessedKey = $state<string | null>(null);

	// Watch the inline tool store for the most recent invocation we own.
	// On `complete` → parse the JSON wire, update live state + show
	// success banner. On `error` → show sticky error banner with Retry.
	$effect(() => {
		if (!lastInvocationId) return;
		const call = inlineToolStore.calls.find((c) => c.id === lastInvocationId);
		if (!call) return;
		const key = `${call.id}:${call.status}`;
		if (key === lastProcessedKey) return;
		// Only react to terminal statuses.
		if (call.status !== "complete" && call.status !== "error") return;
		lastProcessedKey = key;

		if (call.status === "complete" && call.output) {
			try {
				const parsed = JSON.parse(call.output) as ToolPayload;
				const changed = parsed.changedVars ?? [];
				bannerKind = "success";
				bannerText = `Applied — ${summarizeChangedVars(changed)}`;
				bannerError = "";
				bannerVisible = true;

				// Update live state. Per spec: only update applied values for
				// keys whose `var` (or behavior) appears in changedVars.
				if (parsed.knobValues) {
					const next: Record<string, string> = { ...liveAppliedValues };
					const changedSet = new Set(changed);
					for (const k of knobs) {
						const isChanged =
							(k.var && changedSet.has(k.var)) ||
							// scale-spacing knobs touch many --space-* vars at
							// once; consider them "changed" if any space token did
							(k.behavior === "scale-spacing" &&
								changed.some((v) => v.startsWith("--space"))) ||
							// fallback: if the backend echoed a value for this knob
							// AND it differs from current applied, accept it
							(parsed.knobValues![k.key] !== undefined &&
								parsed.knobValues![k.key] !== liveAppliedValues[k.key]);
						if (isChanged && parsed.knobValues![k.key] !== undefined) {
							next[k.key] = parsed.knobValues![k.key]!;
						}
					}
					liveAppliedValues = next;
				}
				if (parsed.tokensBlock !== undefined) liveTokensBlock = parsed.tokensBlock;
				if (parsed.revisions) liveRevisions = parsed.revisions;

				// Bump the iframe so the user sees the new render.
				iframeBustTick = Date.now();

				// Auto-dismiss success banner after 4s.
				if (dismissTimer) clearTimeout(dismissTimer);
				dismissTimer = setTimeout(() => {
					bannerVisible = false;
				}, 4000);
			} catch (err) {
				bannerKind = "error";
				bannerError = err instanceof Error ? err.message : String(err);
				bannerText = "";
				bannerVisible = true;
			}
		} else if (call.status === "error") {
			bannerKind = "error";
			bannerError = call.error ?? "Apply failed";
			bannerText = "";
			bannerVisible = true;
			// Sticky on error — no auto-dismiss timer.
			if (dismissTimer) {
				clearTimeout(dismissTimer);
				dismissTimer = null;
			}
		}
	});

	function buildKnobBody(): Record<string, string> {
		return buildKnobBodyPure(knobs as KnobBodyDescriptor[], values);
	}

	function applyKnobs(): void {
		const body = buildKnobBody();
		if (Object.keys(body).length === 0) return;
		if (!conversationId) return;
		// Pre-generate the invocationId by reading the store's last entry
		// after invokeInlineTool returns. invokeInlineTool itself doesn't
		// expose the id, so we snapshot the calls length, invoke, then
		// pick up the new tail.
		const beforeIds = new Set(inlineToolStore.calls.map((c) => c.id));
		invokeInlineTool({
			conversationId,
			extensionName: "claude-design",
			toolName: "tweak-design",
			input: { draftId, knobs: body },
			messageId,
		});
		const newCall = inlineToolStore.calls.find((c) => !beforeIds.has(c.id));
		if (newCall) {
			lastInvocationId = newCall.id;
			bannerVisible = false; // hide stale banner while running
		}
	}

	function retry(): void {
		applyKnobs();
	}

	function onPickRevision(revisionKnobValues: Record<string, string>): void {
		// Populate the form from the revision's wire-format knobValues.
		// We display whatever the backend stored — encoded form. The
		// range inputs handle bare numerics fine (the unit suffix is
		// preserved in the wire string but the input value itself only
		// needs the numeric prefix). For simplicity we strip well-known
		// suffixes; unknowns pass through.
		const next: Record<string, string> = {};
		for (const k of knobs) {
			const wire = revisionKnobValues[k.key];
			if (wire == null) continue;
			next[k.key] = stripUnit(wire, k);
		}
		values = { ...values, ...next };
		// Then trigger an apply so the iframe + tokens reflect the pick.
		applyKnobs();
	}

	function stripUnit(wire: string, k: KnobDescriptor): string {
		if (k.kind !== "range") return wire;
		// Signed-percent: keep the numeric (drop the leading + and trailing %).
		if (k.behavior === "scale-spacing" && k.unit === "%") {
			return wire.replace(/^\+/, "").replace(/%$/, "");
		}
		if (k.unit) {
			// Strip the trailing unit literal if present.
			if (wire.endsWith(k.unit)) return wire.slice(0, -k.unit.length);
		}
		return wire;
	}

	// ── Dirty state ─────────────────────────────────────────────────

	let dirtyKeys = $derived.by((): Set<string> => {
		const out = new Set<string>();
		for (const k of knobs) {
			if (
				isKnobDirty(
					k as KnobBodyDescriptor,
					values[k.key],
					liveAppliedValues[k.key],
				)
			) {
				out.add(k.key);
			}
		}
		return out;
	});

	// ── Tokens diff drawer ─────────────────────────────────────────

	let diffDrawerOpen = $state(false);
	let diffContainer = $state<HTMLElement | undefined>(undefined);
	let canShowDiff = $derived(
		typeof payload.originalTokensBlock === "string" &&
			typeof liveTokensBlock === "string",
	);
	let diffText = $derived.by((): string => {
		if (!canShowDiff) return "";
		return buildTokensDiffText(
			payload.originalTokensBlock ?? "",
			liveTokensBlock ?? "",
		);
	});
	let diffHtml = $derived.by((): string => {
		if (!diffText) return "";
		try {
			const parsed = Diff2Html.parse(diffText);
			return Diff2Html.html(parsed, {
				outputFormat: "line-by-line",
				drawFileList: false,
			});
		} catch {
			return `<pre>${diffText}</pre>`;
		}
	});
	$effect(() => {
		void diffHtml;
		if (diffContainer && diffDrawerOpen) highlightDiff(diffContainer);
	});

	// ── Revision dropdown ──────────────────────────────────────────

	let revisionPick = $state("");
	function onRevisionChange(e: Event): void {
		const target = e.target as HTMLSelectElement;
		const v = target.value;
		revisionPick = v;
		if (!v) return;
		try {
			const kv = JSON.parse(v) as Record<string, string>;
			onPickRevision(kv);
		} catch {
			// noop — bad value, ignore
		}
		// Reset pick so the same revision can be selected twice in a row.
		revisionPick = "";
		target.value = "";
	}
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
		{#snippet sidebar({ busy })}
			<header class="sidebar-header" data-testid="design-canvas-knobs-title">{knobsTitle}</header>

			{#if liveRevisions.length > 1}
				<label class="revision-picker">
					<span>Revision</span>
					<select
						data-testid="design-canvas-revision-select"
						value={revisionPick}
						onchange={onRevisionChange}
					>
						<option value="">— current —</option>
						{#each liveRevisions as rev (rev.revisionId)}
							<option value={JSON.stringify(rev.knobValues ?? {})}>
								{formatRevisionLabel(rev)}
							</option>
						{/each}
					</select>
				</label>
			{/if}

			{#each knobs as k (k.key)}
				<label class="knob">
					<span>
						{k.label}{#if k.kind === "range"} ({values[k.key] ?? k.current ?? ""}{k.unit ?? ""}){/if}
						{#if dirtyKeys.has(k.key)}
							<span
								class="dirty-dot"
								aria-label="modified"
								data-testid={"dirty-dot-" + k.key}
							></span>
						{/if}
					</span>
					{#if k.kind === "color"}
						<input
							type="color"
							bind:value={values[k.key]}
							disabled={busy}
							data-testid={"knob-" + k.key}
						/>
					{:else if k.kind === "range"}
						<input
							type="range"
							min={k.min}
							max={k.max}
							step={k.step}
							bind:value={values[k.key]}
							disabled={busy}
							data-testid={"knob-" + k.key}
						/>
					{:else if k.kind === "select"}
						<select
							bind:value={values[k.key]}
							disabled={busy}
							data-testid={"knob-" + k.key}
						>
							<option value="">— no override —</option>
							{#each k.options ?? [] as opt (opt)}
								<option value={opt}>{opt}</option>
							{/each}
						</select>
					{:else}
						<input
							type="text"
							placeholder={k.current ?? ""}
							bind:value={values[k.key]}
							disabled={busy}
							data-testid={"knob-" + k.key}
						/>
					{/if}
				</label>
			{/each}

			<button
				type="button"
				class="apply"
				disabled={busy}
				data-testid="design-canvas-apply"
				onclick={applyKnobs}
			>
				{busy ? "Applying…" : "Apply knobs"}
			</button>

			{#if bannerVisible && bannerKind === "success"}
				<div class="banner banner-success" role="status" data-testid="apply-banner-success">
					{bannerText}
				</div>
			{/if}
			{#if bannerVisible && bannerKind === "error"}
				<div class="banner banner-error" role="alert" data-testid="apply-banner-error">
					<span>{bannerError}</span>
					<button
						type="button"
						class="retry"
						data-testid="apply-banner-retry"
						onclick={retry}
					>
						Retry
					</button>
				</div>
			{/if}

			{#if canShowDiff && diffText}
				<details class="tokens-diff" data-testid="tokens-diff-drawer" bind:open={diffDrawerOpen}>
					<summary>Tokens diff</summary>
					<div bind:this={diffContainer} class="tokens-diff-content">
						{#if diffHtml}
							{@html diffHtml}
						{/if}
					</div>
				</details>
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

	.dirty-dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--color-warning, #f59e0b);
		margin-left: 0.25rem;
		vertical-align: middle;
	}

	.revision-picker {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #a0a0a0);
	}

	.revision-picker select {
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

	.banner {
		margin-top: 0.5rem;
		padding: 0.5rem;
		border-radius: 4px;
		font-size: 0.8125rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: space-between;
	}

	.banner-success {
		background: var(--color-surface-secondary, rgba(74, 114, 255, 0.1));
		color: var(--color-text, #e0e0e0);
	}

	.banner-error {
		background: rgba(239, 68, 68, 0.1);
		color: var(--color-error, #ef4444);
	}

	.retry {
		background: transparent;
		border: 1px solid currentColor;
		color: inherit;
		border-radius: 4px;
		padding: 0.125rem 0.5rem;
		cursor: pointer;
		font-size: 0.75rem;
	}

	.tokens-diff {
		margin-top: 0.75rem;
		border: 1px solid var(--color-border, #2a2a2a);
		border-radius: 4px;
		background: var(--color-surface-secondary, #141414);
	}

	.tokens-diff summary {
		cursor: pointer;
		padding: 0.375rem 0.5rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted, #a0a0a0);
	}

	.tokens-diff-content {
		padding: 0.25rem;
		overflow-x: auto;
		max-height: 320px;
	}

	.tokens-diff-content :global(.d2h-wrapper) {
		font-size: 11px;
		background: transparent;
	}
	.tokens-diff-content :global(.d2h-file-header) {
		display: none;
	}
	.tokens-diff-content :global(.d2h-file-wrapper) {
		border: none;
		margin-bottom: 0;
	}
	.tokens-diff-content :global(.d2h-diff-table) {
		border-collapse: collapse;
		font-size: 0.85em;
		width: 100%;
	}
	.tokens-diff-content :global(.d2h-diff-tbody tr td) {
		border: none;
		padding: 0 0.5rem;
	}
</style>
