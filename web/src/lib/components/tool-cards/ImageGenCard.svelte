<!--
  ImageGenCard — renders openai-image-gen-2's `generate` tool output as
  a 1–4 image grid with a click-to-zoom carousel/lightbox for
  side-by-side comparison.

  Why a dedicated card (vs reusing DefaultCard's inline markdown
  renderer): DefaultCard renders the markdown inline at full width, so
  4 generated images stack vertically and you can't compare them. This
  card lays them out in a responsive grid and adds a lightbox that
  cycles between the N images with arrow keys — the workflow a user
  doing "generate 4 variations of X" actually wants.

  Output parsing mirrors DefaultCard.svelte's regex (line 31):
    /!\[([^\]]*)\]\(([^\)]+)\)/g
  inlined per-site rather than hoisted to a util — there are only two
  call sites and the parsing logic is identical.

  The eager-fetch effect mirrors DefaultCard.svelte:36-54 — when the
  truncated `toolCall.output` preview contains an image marker but
  might be cut off (multi-image outputs easily exceed the preview cap),
  we hit /api/tool-calls/{id}/output to get the full output before
  rendering the grid. Without this, only the first 1–2 images survive
  truncation and the carousel collapses to a partial set.

  The lightbox is a small local overlay — the shared
  $lib/image-lightbox.svelte is single-image only and expanding its
  API for one card isn't worth the cross-cutting churn.
-->

<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import CopyButton from "./CopyButton.svelte";
	import { extractInputSummary } from "./utils.js";
	import { progressiveImage } from "$lib/progressive-image.js";

	// `conversationId` and `messageId` are accepted on the prop contract
	// so ToolCardRouter can forward them uniformly (and so the test
	// harness's `rerender` shape stays stable), but the v1 card doesn't
	// consume them — the underscore alias suppresses the unused-binding
	// lint without a no-op statement that Svelte's compiler misreads as
	// a captured-state warning.
	//
	// Defaults intentionally omitted to match KokoroTtsPlayerCard /
	// PriceChartCard prop conventions (per code-reviewer feedback). The
	// optional `?:` on the type already covers the undefined case; an
	// `= ""` default would only hide bugs where the router forgets to
	// forward the prop.
	let {
		toolCall,
		conversationId: _conversationId,
		messageId: _messageId,
		onsendmessage,
	}: {
		toolCall: ToolCallState;
		conversationId?: string;
		messageId?: string;
		/**
		 * Optional send-message hook injected by ToolCardRouter. When wired,
		 * the per-thumbnail Edit affordance can dispatch a fully-formed
		 * `edit` request without forcing the user to copy URLs by hand.
		 * Absent (undefined) → Edit button is hidden; the rest of the card
		 * still works.
		 */
		onsendmessage?: (message: string) => void;
	} = $props();

	let expanded = $state(false);
	let fullOutput = $state<string | null>(null);
	let loadingOutput = $state(false);

	let durationText = $derived(
		toolCall.duration != null ? `${(toolCall.duration / 1000).toFixed(1)}s` : undefined,
	);

	let inputSummary = $derived(extractInputSummary(toolCall.input));

	let displayOutput = $derived.by((): string | undefined => {
		if (fullOutput != null) return fullOutput;
		if (toolCall.output == null) return undefined;
		return typeof toolCall.output === "string"
			? toolCall.output
			: JSON.stringify(toolCall.output, null, 2);
	});

	// Parse `![alt](url)` markdown image markers out of the (possibly
	// truncated) output. Same regex DefaultCard.svelte uses at line 31
	// and ToolCallCard.svelte at line 85.
	interface ParsedImage {
		alt: string;
		url: string;
	}
	let images = $derived.by((): ParsedImage[] => {
		if (!displayOutput) return [];
		const out: ParsedImage[] = [];
		const re = /!\[([^\]]*)\]\(([^\)]+)\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(displayOutput)) !== null) {
			out.push({ alt: m[1] ?? "generated image", url: m[2] ?? "" });
		}
		return out;
	});

	let outputHasImage = $derived(images.length > 0);

	// Eagerly fetch the full output when the truncated preview contains
	// at least one image marker but may have been cut mid-URL or before
	// the later images. Mirrors DefaultCard.svelte:36-54. Without this,
	// a 4-image multi-gen card loses images past the preview cap.
	let imageOutputLoaded = $state(false);
	$effect(() => {
		if (
			toolCall.status === "complete" &&
			outputHasImage &&
			fullOutput == null &&
			!imageOutputLoaded &&
			toolCall.id
		) {
			imageOutputLoaded = true;
			fetch(`/api/tool-calls/${toolCall.id}/output`)
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					if (data?.output != null) {
						fullOutput =
							typeof data.output === "string"
								? data.output
								: JSON.stringify(data.output, null, 2);
					}
				})
				.catch(() => {
					/* non-critical — keep the truncated preview as the fallback */
				});
		}
	});

	// ── Local lightbox ─────────────────────────────────────────────
	// Indexed by position in `images`. -1 = closed. Kept local rather
	// than reusing $lib/image-lightbox.svelte because that store is
	// single-image and adding a "collection mode" just for this card is
	// out of scope.
	let lightboxIndex = $state(-1);
	let lightboxOpen = $derived(lightboxIndex >= 0 && lightboxIndex < images.length);

	function openLightbox(i: number): void {
		if (i >= 0 && i < images.length) lightboxIndex = i;
	}
	function closeLightbox(): void {
		lightboxIndex = -1;
	}
	function next(): void {
		if (images.length === 0) return;
		lightboxIndex = (lightboxIndex + 1) % images.length;
	}
	function prev(): void {
		if (images.length === 0) return;
		lightboxIndex = (lightboxIndex - 1 + images.length) % images.length;
	}

	function handleKey(e: KeyboardEvent): void {
		if (!lightboxOpen) return;
		if (e.key === "Escape") {
			e.preventDefault();
			closeLightbox();
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			next();
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			prev();
		}
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) closeLightbox();
	}

	// ── Inline edit affordance ─────────────────────────────────────
	// Opens a small form inside the card targeted at one thumbnail.
	// On submit, dispatches a fully-formed chat message via the
	// `onsendmessage` prop — the model sees the URL inline and can call
	// the `edit` tool directly without asking the user to re-paste it.
	let editIndex = $state(-1);
	let editPrompt = $state("");
	let editOpen = $derived(editIndex >= 0 && editIndex < images.length);
	let editTextarea: HTMLTextAreaElement | undefined = $state();

	// Focus the textarea whenever the edit form opens, AND when the user
	// switches to a different thumbnail's Edit while one is already open
	// (Svelte reuses the same <textarea> node, so reading `editIndex`
	// inside the effect is what re-fires the focus on switch).
	$effect(() => {
		const idx = editIndex;
		if (idx >= 0 && editTextarea) editTextarea.focus();
	});

	function openEdit(i: number): void {
		if (i < 0 || i >= images.length) return;
		editIndex = i;
		editPrompt = "";
	}
	function closeEdit(): void {
		editIndex = -1;
		editPrompt = "";
	}
	function submitEdit(): void {
		if (!editOpen) return;
		if (!onsendmessage) return;
		const url = images[editIndex]?.url ?? "";
		const desc = editPrompt.trim();
		if (!url || !desc) return;
		// Mention the extension by name so the LLM's tool list resolves
		// `![ext:openai-image-gen-2]` to the right namespace, and emit the
		// URL on its own line so it's unambiguous to parse.
		const msg =
			`![ext:openai-image-gen-2] Edit this image — pass the URL below to ` +
			`the \`edit\` tool's \`images\` array (do not ask me to re-paste it):\n\n` +
			`${url}\n\n` +
			`Edit request: ${desc}`;
		onsendmessage(msg);
		closeEdit();
	}
	function onEditKey(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			closeEdit();
		} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submitEdit();
		}
	}

	// ── Header + expand ────────────────────────────────────────────
	async function handleExpand(): Promise<void> {
		expanded = !expanded;
		if (expanded && fullOutput == null && toolCall.id && toolCall.status !== "running") {
			loadingOutput = true;
			try {
				const res = await fetch(`/api/tool-calls/${toolCall.id}/output`);
				if (res.ok) {
					const data = await res.json();
					if (data.output != null) {
						fullOutput =
							typeof data.output === "string"
								? data.output
								: JSON.stringify(data.output, null, 2);
					}
				}
			} catch {
				/* non-critical */
			}
			loadingOutput = false;
		}
	}

	// CSS class picks the layout based on image count:
	//   1 → single
	//   2 → 2-col side-by-side
	//   3..4 → 2x2 grid (3rd image leaves slot 4 empty; cleaner than
	//          an asymmetric span and consistent with how a user
	//          scanning variations expects to compare).
	let gridClass = $derived(
		images.length === 1
			? "grid-1"
			: images.length === 2
				? "grid-2"
				: "grid-4",
	);
</script>

<svelte:window onkeydown={handleKey} />

<div
	data-testid="tool-card-image-gen"
	class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
>
	<button
		onclick={handleExpand}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={expanded}
	>
		{#if toolCall.status === "running"}
			<svg class="h-4 w-4 shrink-0 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
		{:else if toolCall.status === "complete"}
			<svg class="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
			</svg>
		{:else}
			<svg class="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		{/if}

		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">{toolCall.toolName}</span>
		{#if outputHasImage}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">
				{images.length} image{images.length === 1 ? "" : "s"}
			</span>
		{:else if inputSummary}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">{inputSummary}</span>
		{/if}

		<div class="ml-auto flex items-center gap-1">
			{#if displayOutput && expanded}
				<CopyButton text={displayOutput} />
			{/if}
			{#if durationText}
				<span class="shrink-0 text-xs text-[var(--color-text-muted)]">{durationText}</span>
			{/if}
			<svg
				class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
				stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	</button>

	{#if outputHasImage}
		<div
			class="image-grid {gridClass} border-t border-[var(--color-border)] px-3 py-2"
			data-testid="image-gen-grid"
			data-image-count={images.length}
		>
			{#each images as img, i (img.url + i)}
				<div class="thumb-wrap">
					<button
						type="button"
						class="thumb progressive-img-wrap"
						onclick={() => openLightbox(i)}
						aria-label={`Open image ${i + 1} of ${images.length}`}
						data-testid={`image-gen-thumb-${i}`}
					>
						<img class="progressive-img" src={img.url} alt={img.alt} loading="lazy" use:progressiveImage />
					</button>
					{#if onsendmessage}
						<button
							type="button"
							class="thumb-edit-btn"
							onclick={() => openEdit(i)}
							aria-label={`Edit image ${i + 1}`}
							title="Edit this image"
							data-testid={`image-gen-edit-btn-${i}`}
						>
							<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
								<path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
							</svg>
						</button>
					{/if}
				</div>
			{/each}
		</div>

		{#if editOpen}
			<div
				class="border-t border-[var(--color-border)] px-3 py-2"
				data-testid="image-gen-edit-form"
				data-edit-index={editIndex}
			>
				<p class="mb-1 text-xs text-[var(--color-text-muted)]">
					Editing image {editIndex + 1} of {images.length}
				</p>
				<textarea
					bind:this={editTextarea}
					bind:value={editPrompt}
					onkeydown={onEditKey}
					placeholder="Describe the edit (e.g. 'make it night mode'). Cmd/Ctrl-Enter to send, Esc to cancel."
					rows="2"
					data-testid="image-gen-edit-textarea"
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1.5 text-sm text-[var(--color-text-primary)] resize-y"
				></textarea>
				<div class="mt-1 flex items-center justify-end gap-2">
					<button
						type="button"
						onclick={closeEdit}
						class="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)]"
						data-testid="image-gen-edit-cancel"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={submitEdit}
						disabled={!editPrompt.trim()}
						class="rounded bg-[var(--color-accent,#3b82f6)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
						data-testid="image-gen-edit-send"
					>
						Send
					</button>
				</div>
			</div>
		{/if}
	{/if}

	{#if expanded}
		<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)] px-3 py-2 text-xs">
			{#if toolCall.input != null}
				<div class="mb-2">
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Input</p>
					<pre class="overflow-x-auto rounded bg-[var(--color-surface-secondary)] p-2 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{JSON.stringify(toolCall.input, null, 2)}</pre>
				</div>
			{/if}

			{#if toolCall.status === "error" && toolCall.error}
				<div>
					<p class="font-medium text-red-400 mb-1">Error</p>
					<pre class="overflow-x-auto rounded bg-red-900/20 p-2 text-red-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{toolCall.error}</pre>
				</div>
			{:else if loadingOutput}
				<div>
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Output</p>
					<p class="text-[var(--color-text-muted)] italic">Loading full output...</p>
				</div>
			{:else if displayOutput != null}
				<div>
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Raw output</p>
					<pre class="overflow-x-auto rounded bg-[var(--color-surface-secondary)] p-2 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{displayOutput}</pre>
				</div>
			{/if}

			{#if durationText}
				<p class="mt-2 text-[var(--color-text-muted)]">Duration: {durationText}</p>
			{/if}
		</div>
	{/if}
</div>

{#if lightboxOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="lightbox-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label={`Image ${lightboxIndex + 1} of ${images.length}`}
		data-testid="image-gen-lightbox"
		data-active-index={lightboxIndex}
		tabindex={-1}
		onclick={handleBackdropClick}
	>
		<button
			type="button"
			class="lightbox-close"
			aria-label="Close image preview"
			onclick={closeLightbox}
			data-testid="image-gen-lightbox-close"
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		</button>

		{#if images.length > 1}
			<button
				type="button"
				class="lightbox-nav prev"
				aria-label="Previous image"
				onclick={prev}
				data-testid="image-gen-lightbox-prev"
			>
				<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
				</svg>
			</button>
			<button
				type="button"
				class="lightbox-nav next"
				aria-label="Next image"
				onclick={next}
				data-testid="image-gen-lightbox-next"
			>
				<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
			</button>
		{/if}

		<img
			class="lightbox-img"
			src={images[lightboxIndex]?.url ?? ""}
			alt={images[lightboxIndex]?.alt ?? "generated image"}
			data-testid="image-gen-lightbox-img"
		/>

		{#if images.length > 1}
			<div class="lightbox-counter" data-testid="image-gen-lightbox-counter">
				{lightboxIndex + 1} / {images.length}
			</div>
		{/if}
	</div>
{/if}

<style>
	.image-grid {
		display: grid;
		gap: 0.5rem;
	}
	.image-grid.grid-1 {
		grid-template-columns: minmax(0, 512px);
		justify-content: start;
	}
	.image-grid.grid-2 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.image-grid.grid-4 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(2, minmax(0, 1fr));
	}

	.thumb-wrap {
		position: relative;
	}
	.thumb {
		display: block;
		width: 100%;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		background: var(--color-surface-secondary, transparent);
		overflow: hidden;
		cursor: zoom-in;
		transition: transform 0.12s ease, border-color 0.12s ease;
	}
	.thumb:hover {
		transform: translateY(-1px);
		border-color: var(--color-text-secondary);
	}
	.thumb:focus-visible {
		outline: 2px solid var(--color-accent, white);
		outline-offset: 2px;
	}
	.thumb img {
		display: block;
		width: 100%;
		height: auto;
		object-fit: cover;
	}
	.thumb-edit-btn {
		position: absolute;
		top: 0.375rem;
		right: 0.375rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: none;
		border-radius: 9999px;
		background: rgba(0, 0, 0, 0.55);
		color: white;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.12s, background 0.12s;
	}
	.thumb-wrap:hover .thumb-edit-btn,
	.thumb-edit-btn:focus-visible {
		opacity: 1;
	}
	.thumb-edit-btn:hover {
		background: rgba(0, 0, 0, 0.75);
	}
	.thumb-edit-btn:focus-visible {
		outline: 2px solid var(--color-accent, white);
		outline-offset: 2px;
	}

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
	.lightbox-close,
	.lightbox-nav {
		position: fixed;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: rgba(255, 255, 255, 0.1);
		color: white;
		cursor: pointer;
		transition: background 0.15s;
	}
	.lightbox-close {
		top: 1rem;
		right: 1rem;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
	}
	.lightbox-close:hover,
	.lightbox-nav:hover {
		background: rgba(255, 255, 255, 0.2);
	}
	.lightbox-close:focus-visible,
	.lightbox-nav:focus-visible {
		outline: 2px solid white;
		outline-offset: 2px;
	}
	.lightbox-nav {
		top: 50%;
		transform: translateY(-50%);
		width: 3rem;
		height: 3rem;
		border-radius: 9999px;
	}
	.lightbox-nav.prev {
		left: 1rem;
	}
	.lightbox-nav.next {
		right: 1rem;
	}
	.lightbox-counter {
		position: fixed;
		bottom: 1.25rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.25rem 0.75rem;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.1);
		color: white;
		font-size: 0.875rem;
		font-variant-numeric: tabular-nums;
	}
</style>
