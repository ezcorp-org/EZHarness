<script lang="ts">
	/**
	 * Requester-scoped expose-consent card — Secure User-Site Preview /
	 * Port Exposure, Phase 2 (§3.3 + D3).
	 *
	 * Surfaced in the ORIGINATING conversation only when the port watcher
	 * detects a dev server. Chat is per-user/per-conversation, so only the
	 * requester ever sees this card. Affordances:
	 *
	 *   [Expose]  [Ignore]  [Always expose in this conversation]
	 *
	 * Nothing serves until a click (auto-detect ≠ auto-serve). On Expose /
	 * Always-expose we POST to /api/preview/consent (behind app-origin auth
	 * → the requester IS the session user; the server never trusts a userId
	 * from the body), then surface the ready handoff URL. The access token
	 * gate still applies at serve time.
	 */

	import {
		type PreviewConsentCardData,
		type ConsentAction,
		buildConsentRequest,
	} from "./preview-consent-card-logic.js";

	let { data }: { data: PreviewConsentCardData } = $props();

	type Phase = "prompt" | "pending" | "exposed" | "ignored" | "error";
	let phase = $state<Phase>("prompt");
	let openUrl = $state<string | null>(null);
	let readyUrl = $derived(data.openUrl ?? openUrl);
	let errorMsg = $state<string | null>(null);

	async function act(action: ConsentAction) {
		if (action === "ignore") {
			// Optimistic local non-action; still notify the server so it can
			// audit the choice, but don't block the UI on it.
			phase = "ignored";
			void fetch("/api/preview/consent", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildConsentRequest(data, "ignore")),
			}).catch(() => {});
			return;
		}

		phase = "pending";
		errorMsg = null;
		try {
			const res = await fetch("/api/preview/consent", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildConsentRequest(data, action)),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `Request failed (${res.status})`);
			}
			const body = (await res.json()) as { openUrl?: string };
			if (typeof body.openUrl !== "string" || !body.openUrl) {
				throw new Error("Malformed expose response");
			}
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(body.openUrl);
			} catch {
				throw new Error("Malformed expose response");
			}
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
				throw new Error("Malformed expose response");
			}
			openUrl = body.openUrl;
			phase = "exposed";
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
			phase = "error";
		}
	}
</script>

<div class="ez-card" data-testid="preview-consent-card" data-port={data.port}>
	<div class="ez-card__header">
		<span class="ez-card__icon" aria-hidden="true">🌐</span>
		<div class="ez-card__heading">
			<div class="ez-card__title">{data.title}</div>
			<div class="ez-card__summary">{data.summary}</div>
		</div>
	</div>

	{#if !readyUrl && (phase === "prompt" || phase === "pending")}
		<div class="ez-card__actions">
			<button
				class="ez-card__primary"
				data-testid="preview-consent-expose"
				disabled={phase === "pending"}
				onclick={() => act("expose")}
			>
				Expose
			</button>
			<button
				class="ez-card__secondary"
				data-testid="preview-consent-ignore"
				disabled={phase === "pending"}
				onclick={() => act("ignore")}
			>
				Ignore
			</button>
			<button
				class="ez-card__secondary"
				data-testid="preview-consent-always"
				disabled={phase === "pending"}
				onclick={() => act("always-expose")}
			>
				Always expose in this conversation
			</button>
		</div>
	{:else if readyUrl || phase === "exposed"}
		<div class="ez-card__actions">
			<a class="ez-card__primary" data-testid="preview-consent-open" href={readyUrl}>
				Open preview
			</a>
		</div>
	{:else if phase === "ignored"}
		<div class="ez-card__summary" data-testid="preview-consent-ignored">Ignored.</div>
	{:else if phase === "error"}
		<div class="ez-card__error" data-testid="preview-consent-error">{errorMsg}</div>
		<div class="ez-card__actions">
			<button class="ez-card__secondary" onclick={() => (phase = "prompt")}>Try again</button>
		</div>
	{/if}
</div>

<style>
	.ez-card {
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		border-radius: 0.6rem;
		padding: 0.85rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.ez-card__header {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.ez-card__icon {
		font-size: 1.1rem;
		line-height: 1.2;
	}
	.ez-card__heading {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ez-card__title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--color-text-primary);
	}
	.ez-card__summary {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}
	.ez-card__error {
		font-size: 0.8rem;
		color: var(--color-danger, #ff6b6b);
	}
	.ez-card__actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.ez-card__primary,
	.ez-card__secondary {
		display: inline-block;
		text-align: center;
		text-decoration: none;
		padding: 0.5rem 0.85rem;
		font-size: 0.85rem;
		font-weight: 600;
		border-radius: 0.4rem;
		border: none;
		cursor: pointer;
		transition: filter 120ms ease;
	}
	.ez-card__primary {
		background: var(--color-accent, #4c8cff);
		color: white;
	}
	.ez-card__secondary {
		background: var(--color-surface-tertiary, #2a2a30);
		color: var(--color-text-primary);
		border: 1px solid var(--color-border);
	}
	.ez-card__primary:hover,
	.ez-card__secondary:hover {
		filter: brightness(1.1);
	}
	.ez-card__primary:disabled,
	.ez-card__secondary:disabled {
		filter: grayscale(0.5);
		cursor: not-allowed;
	}
</style>
