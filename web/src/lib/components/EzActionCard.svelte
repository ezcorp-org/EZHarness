<script lang="ts" module>
	/**
	 * EZ Actions v1 — inline result card for `![EZ:*]` invocations.
	 *
	 * Rendered by ChatMessage.svelte when `message.role ===
	 * "ez-action-result"`. The message's `content` is the
	 * JSON-encoded `EzActionResult` shape from
	 * `src/runtime/ez-actions/types.ts`.
	 *
	 * Visual language mirrors EzToolResultCard.svelte (the
	 * propose-tool result card) — same `.ez-card` shell + header
	 * shape — but variant-driven coloring on the left border and
	 * icon, plus an optional ref-link (e.g. lesson slug → /memories
	 * Lessons tab) for `kind: "success"` results.
	 *
	 * Variants map:
	 *   - success → emerald
	 *   - info    → sky
	 *   - warning → amber
	 *   - error   → rose
	 *
	 * The whole card is keyboard-accessible: the title doubles as
	 * an aria-label and the ref-link (when present) is a real
	 * <a href> rather than a button so screen readers + Cmd-click
	 * + open-in-new-tab all work as expected.
	 */
	export interface EzActionCardSpec {
		title: string;
		body: string;
		variant: "success" | "info" | "warning" | "error";
	}

	export type EzActionCardRef = { kind: "lesson"; slug: string };

	export interface EzActionCardResult {
		kind: "success" | "decline" | "error";
		card: EzActionCardSpec;
		ref?: EzActionCardRef;
	}
</script>

<script lang="ts">
	let { result }: { result: EzActionCardResult } = $props();

	// Build ref-link href for the success-card slug navigation. Only
	// emitted when `kind === "success"` AND `ref` is present, so the
	// decline / error variants never carry a CTA. v1 supports a single
	// ref kind (`lesson`); the switch leaves room for future additions
	// (`!EZ:summarize` → conversation-export, `!EZ:fork-conv` →
	// /chat/[forkId], etc).
	function refHref(ref: EzActionCardRef | undefined): string | null {
		if (!ref) return null;
		switch (ref.kind) {
			case "lesson":
				// /memories Lessons tab pre-filtered to the slug. The
				// tab supports a `?lesson=<slug>` query parameter
				// for deep-linking (lessons-keeper v1.5 admin tab).
				return `/memories?tab=lessons&lesson=${encodeURIComponent(ref.slug)}`;
		}
	}

	function refLabel(ref: EzActionCardRef | undefined): string {
		if (!ref) return "";
		switch (ref.kind) {
			case "lesson":
				return `View lesson: ${ref.slug}`;
		}
	}

	const VARIANT_ICON: Record<EzActionCardSpec["variant"], string> = {
		success: "✓",
		info: "ℹ",
		warning: "⚠",
		error: "✗",
	};

	let href = $derived(refHref(result.ref));
	let label = $derived(refLabel(result.ref));
	let variant = $derived(result.card.variant);
	let icon = $derived(VARIANT_ICON[variant]);
</script>

<div
	class="ez-action-card variant-{variant}"
	data-testid="ez-action-card"
	data-variant={variant}
	data-kind={result.kind}
	role="status"
	aria-label={result.card.title}
>
	<div class="ez-action-card__header">
		<span class="ez-action-card__icon" aria-hidden="true">{icon}</span>
		<div class="ez-action-card__heading">
			<div class="ez-action-card__title">{result.card.title}</div>
			<div class="ez-action-card__body">{result.card.body}</div>
		</div>
	</div>
	{#if href && result.kind === "success"}
		<div class="ez-action-card__actions">
			<a
				class="ez-action-card__link"
				data-testid="ez-action-card-ref-link"
				data-ref-kind={result.ref?.kind}
				data-ref-slug={result.ref && result.ref.kind === "lesson" ? result.ref.slug : null}
				href={href}
			>
				{label} →
			</a>
		</div>
	{/if}
</div>

<style>
	.ez-action-card {
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		border-radius: 0.6rem;
		padding: 0.85rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		border-left-width: 3px;
	}
	.ez-action-card.variant-success {
		border-left-color: rgb(16 185 129); /* emerald-500 */
	}
	.ez-action-card.variant-info {
		border-left-color: rgb(14 165 233); /* sky-500 */
	}
	.ez-action-card.variant-warning {
		border-left-color: rgb(245 158 11); /* amber-500 */
	}
	.ez-action-card.variant-error {
		border-left-color: rgb(244 63 94); /* rose-500 */
	}
	.ez-action-card__header {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.ez-action-card__icon {
		font-size: 1.1rem;
		line-height: 1.2;
		font-weight: 700;
	}
	.variant-success .ez-action-card__icon {
		color: rgb(16 185 129);
	}
	.variant-info .ez-action-card__icon {
		color: rgb(14 165 233);
	}
	.variant-warning .ez-action-card__icon {
		color: rgb(245 158 11);
	}
	.variant-error .ez-action-card__icon {
		color: rgb(244 63 94);
	}
	.ez-action-card__heading {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		flex: 1;
	}
	.ez-action-card__title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--color-text-primary);
	}
	.ez-action-card__body {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ez-action-card__actions {
		display: flex;
		gap: 0.5rem;
	}
	.ez-action-card__link {
		display: inline-block;
		padding: 0.4rem 0.7rem;
		font-size: 0.85rem;
		font-weight: 500;
		text-decoration: none;
		border-radius: 0.4rem;
		color: var(--color-text-primary);
		background: var(--color-surface-tertiary);
		border: 1px solid var(--color-border);
	}
	.ez-action-card__link:hover {
		filter: brightness(1.1);
	}
	.ez-action-card__link:focus-visible {
		outline: 2px solid rgb(14 165 233);
		outline-offset: 2px;
	}
</style>
