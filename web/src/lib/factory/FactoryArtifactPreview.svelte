<script lang="ts">
	import { Download, ShieldCheck, X } from "lucide-svelte";
	import { onDestroy, onMount, tick } from "svelte";
	import type { FactoryArtifactResource } from "@ezcorp/factory-sdk/types";
	import type { FactoryRunInspectorApi } from "./client";
	import { FACTORY_PREVIEW_IMAGE_BYTES, browserImageCodec, planArtifactPreview, reencodeRaster, type FactoryImageCodec, type FactoryPreviewPlan } from "./preview";

	let {
		projectId,
		runId,
		artifact,
		api,
		onClose,
		codec = browserImageCodec,
	}: {
		projectId: string;
		runId: string;
		artifact: FactoryArtifactResource;
		api: Pick<FactoryRunInspectorApi, "artifactTicket" | "artifactBytes">;
		onClose: () => void;
		codec?: FactoryImageCodec;
	} = $props();

	let plan = $state<FactoryPreviewPlan | null>(null);
	let imageUrl = $state<string | null>(null);
	let failure = $state("");
	let closeButton: HTMLButtonElement;
	let returnFocus: Element | null = null;

	onMount(() => {
		returnFocus = document.activeElement;
		void tick().then(() => closeButton?.focus());
		void load();
	});

	onDestroy(() => {
		if (imageUrl) URL.revokeObjectURL(imageUrl);
		if (returnFocus instanceof HTMLElement) returnFocus.focus();
	});

	async function load(): Promise<void> {
		try {
			const ticket = await api.artifactTicket(projectId, runId, artifact.artifactId);
			if (ticket.encodedBytes > FACTORY_PREVIEW_IMAGE_BYTES) {
				plan = { kind: "download", reason: "The artifact is larger than the preview limit." };
				return;
			}
			const bytes = await api.artifactBytes(ticket, FACTORY_PREVIEW_IMAGE_BYTES);
			const next = planArtifactPreview(bytes, ticket.encodedBytes);
			if (next.kind === "image") {
				const blob = await reencodeRaster(bytes, next.type, codec);
				imageUrl = URL.createObjectURL(blob);
			}
			plan = next;
		} catch (error) {
			failure = error instanceof Error ? error.message : "The artifact could not be read.";
		}
	}

	async function download(): Promise<void> {
		try {
			const ticket = await api.artifactTicket(projectId, runId, artifact.artifactId);
			const link = document.createElement("a");
			link.href = ticket.url;
			link.rel = "noopener";
			link.download = "";
			document.body.append(link);
			link.click();
			link.remove();
		} catch (error) {
			failure = error instanceof Error ? error.message : "The artifact could not be downloaded.";
		}
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === "Escape") { event.preventDefault(); onClose(); }
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="preview-backdrop" role="presentation" onclick={event => event.target === event.currentTarget && onClose()}>
	<div class="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-preview-title" data-testid="factory-artifact-preview">
		<header>
			<div>
				<p class="eyebrow">{artifact.kind.replaceAll("_", " ")}</p>
				<h2 id="artifact-preview-title" title={artifact.artifactId}>{artifact.nodeInstanceId ?? artifact.artifactId}</h2>
			</div>
			<button bind:this={closeButton} class="icon-button" aria-label="Close artifact preview" onclick={onClose}><X size={17} /></button>
		</header>
		<p class="safety"><ShieldCheck size={14} /> Shown as escaped text or a re-encoded image. Nothing in this artifact runs in the console.</p>
		<div class="preview-body">
			{#if failure}
				<p class="failure" role="alert">{failure}</p>
			{:else if !plan}
				<p class="muted" aria-live="polite">Reading the artifact…</p>
			{:else if plan.kind === "image" && imageUrl}
				<img src={imageUrl} alt={`Re-encoded preview of ${artifact.artifactId}`} />
			{:else if plan.kind === "json" || plan.kind === "text"}
				{#if plan.kind === "text" && plan.markup}<p class="markup-note">This is markup. It is shown as source and is never rendered.</p>{/if}
				<pre data-testid="factory-artifact-text">{plan.text}</pre>
				{#if plan.truncated}<p class="muted">Only the first 64 KiB is shown. Download the artifact for the rest.</p>{/if}
			{:else if plan.kind === "download"}
				<p class="muted">{plan.reason}</p>
			{/if}
		</div>
		<footer>
			<small><code>{artifact.digest}</code></small>
			<button class="button-primary" onclick={download}><Download size={14} /> Download</button>
		</footer>
	</div>
</div>

<style>
	.preview-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; overflow: auto; place-items: start center; background: rgb(4 8 18 / .72); padding: 5vh 16px; }
	.preview-dialog { display: grid; width: min(880px, 100%); max-height: 90vh; grid-template-rows: auto auto minmax(0, 1fr) auto; border: 1px solid var(--color-border-strong); border-top: 4px solid var(--color-accent); border-radius: 4px; background: var(--color-surface); color: var(--color-text-primary); box-shadow: var(--shadow-2xl); }
	header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--color-border); padding: 14px 18px; }
	header div { min-width: 0; }
	h2 { overflow: hidden; margin: 3px 0 0; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
	.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: var(--color-accent); }
	.safety { display: flex; align-items: center; gap: 6px; margin: 0; border-bottom: 1px solid var(--color-border); background: var(--color-surface-secondary); padding: 8px 18px; color: var(--color-text-secondary); font-size: 11px; }
	.preview-body { min-height: 160px; overflow: auto; padding: 14px 18px; }
	pre { margin: 0; border: 1px solid var(--color-border); background: var(--color-surface-secondary); padding: 12px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
	img { display: block; max-width: 100%; height: auto; margin: 0 auto; border: 1px solid var(--color-border); background: repeating-conic-gradient(var(--color-surface-secondary) 0% 25%, var(--color-surface) 0% 50%) 50% / 16px 16px; }
	.markup-note { margin: 0 0 8px; color: var(--color-amber-500); font-size: 11px; font-weight: 700; }
	.muted { margin: 8px 0 0; color: var(--color-text-muted); font-size: 12px; }
	.failure { margin: 0; color: var(--color-red-600); font-size: 12px; }
	footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--color-border); padding: 12px 18px; }
	footer small { min-width: 0; overflow: hidden; color: var(--color-text-muted); text-overflow: ellipsis; white-space: nowrap; }
	code { font-family: var(--font-mono); font-size: 10px; }
	.icon-button { display: inline-grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border: 1px solid var(--color-border-strong); border-radius: 3px; background: var(--color-surface-elevated); color: var(--color-text-secondary); cursor: pointer; }
	.button-primary { display: inline-flex; min-height: 34px; flex: 0 0 auto; align-items: center; gap: 6px; border: 1px solid var(--color-accent); border-radius: 3px; background: var(--color-accent); padding: 7px 12px; color: white; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
	button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
	@media (max-width: 700px) {
		.preview-backdrop { padding: 12px 8px; }
		footer { flex-direction: column; align-items: stretch; }
	}
</style>
